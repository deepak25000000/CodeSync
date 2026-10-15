"""Sync job execution: validated submission -> GitHub repository file(s)."""

from __future__ import annotations

import asyncio
import logging
import random
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.db import Database
from app.logging_utils import log_event
from app.models import (
    JobState,
    OAuthConnection,
    Submission,
    SubmissionStatus,
    SyncAttempt,
    SyncJob,
    UserSettings,
    utcnow,
)
from app.security import CredentialCipher
from app.services.backoff import compute_backoff
from app.services.errors import ClassifiedError, SyncError
from app.services.filegen import (
    build_file_content,
    build_progress_json,
    build_repo_path,
    header_problem_id,
    update_readme,
)
from app.services.fingerprint import find_marker
from app.services.github import GitHubClient, b64decode

logger = logging.getLogger("codesync.sync")

GithubFactory = Callable[[str], Any]


def default_github_factory(settings: Settings) -> GithubFactory:
    def factory(token: str) -> GitHubClient:
        return GitHubClient(
            token=token,
            base_url=settings.github_api_base_url,
            timeout=settings.github_timeout_seconds,
        )

    return factory


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=UTC)
    return dt


def get_settings_row(session: Session, user_id: int) -> UserSettings:
    row = session.get(UserSettings, user_id)
    if row is None:
        row = UserSettings(user_id=user_id)
        session.add(row)
        session.flush()
    return row


def get_github_token(session: Session, user_id: int, cipher: CredentialCipher) -> str:
    conn = session.execute(
        select(OAuthConnection).where(
            OAuthConnection.user_id == user_id,
            OAuthConnection.provider == "github",
            OAuthConnection.revoked_at.is_(None),
        )
    ).scalar_one_or_none()
    if conn is None:
        raise SyncError(
            "AUTH_MISSING", "GitHub is not connected. Connect GitHub in options.", False
        )
    return cipher.decrypt(conn.access_token_encrypted)


def sync_platform_counts(session: Session, user_id: int) -> dict[str, int]:
    """Count synced submissions per platform (for README/progress).

    The currently executing job is still in SYNCING state while auxiliary files
    are written, so it must be included to keep README counts correct on the
    very first sync.
    """
    rows = session.execute(
        select(Submission.platform, Submission.id)
        .join(SyncJob, SyncJob.submission_id == Submission.id)
        .where(
            SyncJob.user_id == user_id,
            SyncJob.state.in_([JobState.synced.value, JobState.syncing.value]),
        )
    ).all()
    counts: dict[str, int] = {}
    for platform, _sid in rows:
        counts[platform] = counts.get(platform, 0) + 1
    return counts


class SyncWorker:
    """Executes a single queued job to a terminal or retryable state."""

    def __init__(self, db: Database, settings: Settings, github_factory: GithubFactory) -> None:
        self.db = db
        self.settings = settings
        self.github_factory = github_factory
        self.cipher = CredentialCipher(settings.credentials_key)
        self.rng = random.Random()

    async def execute(self, job_id: int) -> SyncJob:
        with self.db.session() as session:
            job = session.get(SyncJob, job_id)
            if job is None:
                raise ValueError(f"sync job {job_id} not found")
            submission = session.get(Submission, job.submission_id)
            if submission is None:  # pragma: no cover - cascade should prevent this
                raise ValueError(f"submission {job.submission_id} not found")

            job.state = JobState.syncing.value
            job.attempts += 1
            attempt_no = job.attempts
            session.flush()

            try:
                result = await self._sync_once(session, job, submission)
            except ClassifiedError as exc:
                self._handle_failure(session, job, attempt_no, exc)
                log_event(
                    logger,
                    "sync_attempt_failed",
                    level=logging.WARNING,
                    job_id=job.id,
                    attempt=attempt_no,
                    code=exc.code,
                    retryable=exc.retryable,
                )
            except Exception as exc:  # unexpected: classify as transient
                err = SyncError("UNEXPECTED", f"{type(exc).__name__}: {exc}", True)
                self._handle_failure(session, job, attempt_no, err)
                log_event(
                    logger,
                    "sync_attempt_error",
                    level=logging.ERROR,
                    job_id=job.id,
                    attempt=attempt_no,
                    error=str(exc),
                )
            else:
                self._handle_success(session, job, attempt_no, result)
            session.flush()
            session.refresh(job)
            return job

    # ------------------------------------------------------------------ core
    async def _sync_once(
        self, session: Session, job: SyncJob, submission: Submission
    ) -> dict[str, Any]:
        if submission.status != SubmissionStatus.validated.value:
            raise SyncError(
                "INVALID_VERDICT",
                f"Submission verdict is {submission.verdict}; only accepted solutions are synced.",
                False,
            )
        if not submission.code or not submission.code.strip():
            raise SyncError("CODE_UNAVAILABLE", "Solution code is missing; cannot sync.", False)

        settings_row = get_settings_row(session, job.user_id)
        if not settings_row.repo_full_name:
            raise SyncError(
                "NO_REPOSITORY",
                "No GitHub repository selected. Choose a repository in options.",
                False,
            )

        language = submission.language
        try:
            path = build_repo_path(
                settings_row,
                submission.platform,
                {
                    "title": submission.title,
                    "language": language,
                    "problem_id": submission.problem_id,
                },
            )
        except Exception as exc:
            raise SyncError("INVALID_FILE", str(exc), False) from exc

        job.repo_full_name = settings_row.repo_full_name
        job.branch = settings_row.branch
        job.file_path = path

        token = get_github_token(session, job.user_id, self.cipher)
        content = build_file_content(
            submission, submission.fingerprint, settings_row.repo_full_name, utcnow()
        )
        content_bytes = content.encode("utf-8")
        commit_message = _commit_message(submission, path)

        async with self.github_factory(token) as gh:
            existing = await gh.get_file(settings_row.repo_full_name, path, settings_row.branch)

            if _belongs_to_other_problem(existing, submission.problem_id):
                # The title-derived path holds a DIFFERENT problem (a stale or
                # duplicated title must never clobber another problem's file):
                # give this problem its own problem-id filename instead.
                alt_path: str | None = None
                try:
                    alt_path = build_repo_path(
                        settings_row,
                        submission.platform,
                        {
                            "title": submission.title,
                            "language": language,
                            "problem_id": submission.problem_id,
                        },
                        prefer_problem_id=True,
                    )
                except Exception:
                    logger.exception("problem-id fallback path failed; keeping title path")
                if alt_path and alt_path != path:
                    path = alt_path
                    job.file_path = path
                    commit_message = _commit_message(submission, path)
                    existing = await gh.get_file(
                        settings_row.repo_full_name, path, settings_row.branch
                    )

            if existing is not None:
                outcome = await self._handle_existing_file(
                    gh, session, job, submission, settings_row, path, content_bytes, existing
                )
                if outcome is not None:
                    return outcome

            put = await gh.put_file(
                settings_row.repo_full_name,
                path,
                content_bytes,
                commit_message,
                settings_row.branch,
                sha=(existing or {}).get("sha"),
            )
            job.commit_sha = put.get("commit_sha")

            # Auxiliary files: progress.json then README.md (each idempotent, sha-aware).
            await self._update_progress(gh, session, job, submission, settings_row, utcnow())
            await self._update_readme(gh, session, job, settings_row)

        return {"file_path": path, "commit_sha": job.commit_sha, "skipped_duplicate": False}

    async def _handle_existing_file(
        self,
        gh: Any,
        session: Session,
        job: SyncJob,
        submission: Submission,
        settings_row: UserSettings,
        path: str,
        content_bytes: bytes,
        existing: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Return a result dict when no upload is needed, else None to proceed."""
        try:
            current = b64decode(existing.get("content") or "").decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            current = ""

        marker = find_marker(current)
        if marker == submission.fingerprint:
            # Identical solution already in the repo: never create a duplicate commit.
            return {"file_path": path, "commit_sha": job.commit_sha, "skipped_duplicate": True}
        if marker is None:
            # A hand-written file owns this path; do not clobber user content.
            raise SyncError(
                "CONFLICT",
                f"A file already exists at {path} and was not created by CodeSync. "
                "Rename or remove it, then retry.",
                False,
            )
        # Marker from a previous CodeSync sync of the same path with different code:
        # treat as a legitimate content update (sha passed through to put_file).
        return None

    async def _update_progress(
        self,
        gh: Any,
        session: Session,
        job: SyncJob,
        submission: Submission,
        settings_row: UserSettings,
        synced_at: datetime,
    ) -> None:
        if not settings_row.repo_full_name:
            return
        path = f"{settings_row.root_folder.rstrip('/')}/progress.json"
        existing = await gh.get_file(settings_row.repo_full_name, path, settings_row.branch)
        raw = b64decode(existing.get("content") or "") if existing else None
        data = build_progress_json(
            raw, submission, submission.fingerprint, settings_row.repo_full_name, synced_at
        )
        if raw == data:
            return
        sha = (existing or {}).get("sha")
        try:
            await gh.put_file(
                settings_row.repo_full_name,
                path,
                data,
                f"[CodeSync] Update progress for {submission.platform}: {submission.title}",
                settings_row.branch,
                sha=sha,
            )
        except SyncError as exc:
            if exc.code != "CONFLICT":
                raise
            # Concurrent writer won the race: re-read once and retry.
            fresh = await gh.get_file(settings_row.repo_full_name, path, settings_row.branch)
            fresh_raw = b64decode(fresh.get("content") or "") if fresh else None
            merged = build_progress_json(
                fresh_raw,
                submission,
                submission.fingerprint,
                settings_row.repo_full_name,
                synced_at,
            )
            await gh.put_file(
                settings_row.repo_full_name,
                path,
                merged,
                f"[CodeSync] Update progress for {submission.platform}: {submission.title}",
                settings_row.branch,
                sha=(fresh or {}).get("sha"),
            )

    async def _update_readme(
        self,
        gh: Any,
        session: Session,
        job: SyncJob,
        settings_row: UserSettings,
    ) -> None:
        path = f"{settings_row.root_folder.rstrip('/')}/README.md"
        counts = sync_platform_counts(session, job.user_id)
        existing = await gh.get_file(settings_row.repo_full_name, path, settings_row.branch)
        raw = b64decode(existing.get("content") or "") if existing else None
        data = update_readme(raw, counts)
        if raw == data:
            return
        try:
            await gh.put_file(
                settings_row.repo_full_name,
                path,
                data,
                "[CodeSync] Update progress README",
                settings_row.branch,
                sha=(existing or {}).get("sha"),
            )
        except SyncError as exc:
            if exc.code != "CONFLICT":
                raise
            fresh = await gh.get_file(settings_row.repo_full_name, path, settings_row.branch)
            fresh_raw = b64decode(fresh.get("content") or "") if fresh else None
            merged = update_readme(fresh_raw, counts)
            await gh.put_file(
                settings_row.repo_full_name,
                path,
                merged,
                "[CodeSync] Update progress README",
                settings_row.branch,
                sha=(fresh or {}).get("sha"),
            )

    # ------------------------------------------------------------- outcomes
    def _handle_success(
        self, session: Session, job: SyncJob, attempt_no: int, result: dict[str, Any]
    ) -> None:
        job.file_path = result.get("file_path") or job.file_path
        job.commit_sha = result.get("commit_sha") or job.commit_sha
        job.skipped_duplicate = bool(result.get("skipped_duplicate"))
        job.state = JobState.synced.value
        job.error_code = None
        job.last_error = None
        job.next_attempt_at = None
        job.completed_at = utcnow()
        session.add(
            SyncAttempt(
                job_id=job.id,
                attempt_no=attempt_no,
                state=JobState.synced.value,
                http_status=200,
            )
        )

    def _handle_failure(
        self, session: Session, job: SyncJob, attempt_no: int, err: ClassifiedError
    ) -> None:
        retryable = err.retryable and job.attempts < job.max_attempts
        job.error_code = err.code
        job.last_error = err.message[:2000]
        if retryable:
            delay = err.retry_after
            if delay is None:
                delay = compute_backoff(job.attempts, rng=self.rng)
            else:
                delay = min(600.0, delay)
            job.state = JobState.retry_pending.value
            job.next_attempt_at = datetime.now(UTC) + timedelta(seconds=delay)
        else:
            job.state = JobState.failed.value
            job.next_attempt_at = None
            job.completed_at = utcnow()
        session.add(
            SyncAttempt(
                job_id=job.id,
                attempt_no=attempt_no,
                state=job.state,
                error_code=err.code,
                error_message=err.message[:2000],
                http_status=err.http_status,
            )
        )


def _belongs_to_other_problem(existing: dict[str, Any] | None, problem_id: str | None) -> bool:
    """True only on explicit evidence that a CodeSync file belongs to another problem.

    Requires the existing file to carry a `Problem ID:` header that differs from
    this submission's id. Files without that header (hand-written or legacy) keep
    their normal conflict/overwrite handling.
    """
    if existing is None or not problem_id:
        return False
    try:
        current = b64decode(existing.get("content") or "").decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return False
    owner = header_problem_id(current)
    return owner is not None and owner.lower() != problem_id.lower()


def _commit_message(submission: Submission, path: str) -> str:
    platform = submission.platform.capitalize()
    label = submission.problem_id or submission.title
    filename = path.rsplit("/", 1)[-1]
    return f"[CodeSync] {platform}: {label} ({filename})"


class SyncScheduler:
    """Polls for queued/due jobs and executes them. Started from app lifespan."""

    def __init__(
        self,
        db: Database,
        settings: Settings,
        github_factory: GithubFactory | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.worker = SyncWorker(db, settings, github_factory or default_github_factory(settings))
        self._task: asyncio.Task[None] | None = None
        self._stopping = False

    async def drain(self, limit: int = 25) -> int:
        """Process all due jobs once. Returns number of jobs executed."""
        processed = 0
        for _ in range(limit):
            job_id = self._next_due_job_id()
            if job_id is None:
                break
            await self.worker.execute(job_id)
            processed += 1
        return processed

    def _next_due_job_id(self) -> int | None:
        now = datetime.now(UTC)
        with self.db.session() as session:
            rows = (
                session.execute(
                    select(SyncJob).where(
                        SyncJob.state.in_([JobState.queued.value, JobState.retry_pending.value])
                    )
                )
                .scalars()
                .all()
            )
            for job in rows:
                next_at = _as_utc(job.next_attempt_at)
                if next_at is None or next_at <= now:
                    return job.id
        return None

    async def start(self) -> None:  # pragma: no cover - background loop
        self._stopping = False

        async def _loop() -> None:
            while not self._stopping:
                try:
                    await self.drain()
                except Exception:
                    logger.exception("sync scheduler iteration failed")
                await asyncio.sleep(self.settings.sync_poll_interval_seconds)

        self._task = asyncio.create_task(_loop())

    async def stop(self) -> None:  # pragma: no cover - background loop
        self._stopping = True
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
            self._task = None

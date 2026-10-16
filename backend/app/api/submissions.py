"""Submission ingestion (idempotent) and listing."""

from __future__ import annotations

import json
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db_session
from app.logging_utils import log_event
from app.models import (
    JobState,
    PlatformIntegration,
    Submission,
    SubmissionStatus,
    SyncJob,
    User,
    Verdict,
)
from app.schemas import (
    PageMeta,
    SubmissionCreateIn,
    SubmissionCreateOut,
    SubmissionListOut,
    SubmissionOut,
)
from app.services.fingerprint import content_hash, stable_fingerprint
from app.services.sync_worker import get_settings_row

logger = logging.getLogger("codesync.api.submissions")

router = APIRouter(tags=["submissions"])

MAX_PER_PAGE = 100


def status_for_verdict(verdict: str) -> str:
    if verdict in (Verdict.accepted.value, Verdict.manual.value):
        return SubmissionStatus.validated.value
    if verdict == Verdict.rejected.value:
        return SubmissionStatus.rejected.value
    if verdict == Verdict.pending.value:
        return SubmissionStatus.detected.value
    return SubmissionStatus.unsupported.value


def _platform_enabled(session: Session, user_id: int, platform: str) -> bool:
    row = session.execute(
        select(PlatformIntegration).where(
            PlatformIntegration.user_id == user_id, PlatformIntegration.platform == platform
        )
    ).scalar_one_or_none()
    return True if row is None else bool(row.enabled)


def _is_stuck_invalid_file(job: SyncJob) -> bool:
    return job.state == JobState.failed.value and job.error_code == "INVALID_FILE"


def _repair_unknown_language(existing: Submission, body: SubmissionCreateIn) -> bool:
    """A duplicate replay that now carries a KNOWN language heals an `unknown` row.

    Id-based fingerprints deliberately ignore language and code, so replaying a
    submission after detection improved would otherwise keep returning the old
    `unknown` row — and its permanently failed job — forever. Only ever flips
    rows whose stored language is missing/`unknown`; everything else is left
    untouched (dedupe semantics stay exactly as documented).
    """
    language = (body.language or "").strip()
    if not language or language.lower() == "unknown":
        return False
    if (existing.language or "").strip().lower() not in ("", "unknown"):
        return False
    if not existing.code and not body.code:
        return False
    existing.language = language
    if not existing.code and body.code:
        existing.code = body.code
        existing.content_hash = content_hash(body.code)
    existing.fingerprint = stable_fingerprint(
        existing.platform, existing.external_id, existing.url, language, existing.code
    )
    return True


@router.post(
    "/submissions", response_model=SubmissionCreateOut, status_code=status.HTTP_201_CREATED
)
def create_submission(
    body: SubmissionCreateIn,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SubmissionCreateOut:
    if not _platform_enabled(session, user.id, body.platform):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "PLATFORM_DISABLED",
                "message": f"The {body.platform} integration is disabled for this account.",
            },
        )

    fingerprint = stable_fingerprint(
        body.platform, body.external_id, body.url, body.language, body.code
    )
    existing = session.execute(
        select(Submission).where(
            Submission.user_id == user.id, Submission.fingerprint == fingerprint
        )
    ).scalar_one_or_none()
    if existing is not None:
        repaired = _repair_unknown_language(existing, body)
        job = session.execute(
            select(SyncJob).where(SyncJob.submission_id == existing.id)
        ).scalar_one_or_none()
        if repaired and job is not None and _is_stuck_invalid_file(job):
            # The row now has a usable language; give the permanently failed
            # job a fresh chance instead of returning it as-is forever.
            job.state = JobState.queued.value
            job.error_code = None
            job.last_error = None
            job.attempts = 0
            job.next_attempt_at = None
            job.completed_at = None
            log_event(
                logger,
                "submission_language_repaired",
                job_id=job.id,
                submission_id=existing.id,
                language=existing.language,
            )
        return SubmissionCreateOut(
            submission=SubmissionOut.from_model(existing),
            duplicate=True,
            sync_job_id=job.id if job else None,
        )

    settings_row = get_settings_row(session, user.id)
    auto_sync = body.auto_sync if body.auto_sync is not None else settings_row.auto_sync
    new_status = status_for_verdict(body.verdict)

    submission = Submission(
        user_id=user.id,
        platform=body.platform,
        external_id=body.external_id,
        problem_id=body.problem_id,
        title=body.title,
        url=body.url,
        language=body.language,
        code=body.code,
        verdict=body.verdict,
        status=new_status,
        submitted_at=_as_utc(body.submitted_at),
        fingerprint=fingerprint,
        content_hash=content_hash(body.code),
        metadata_json=json.dumps(body.metadata) if body.metadata else None,
    )
    session.add(submission)
    session.flush()

    sync_job_id: int | None = None
    if new_status == SubmissionStatus.validated.value and auto_sync:
        job = SyncJob(
            user_id=user.id,
            submission_id=submission.id,
            state=JobState.queued.value,
            max_attempts=5,
        )
        session.add(job)
        session.flush()
        sync_job_id = job.id

    log_event(
        logger,
        "submission_created",
        submission_id=submission.id,
        platform=body.platform,
        verdict=body.verdict,
        status=new_status,
        sync_job_id=sync_job_id,
    )
    return SubmissionCreateOut(
        submission=SubmissionOut.from_model(submission),
        duplicate=False,
        sync_job_id=sync_job_id,
    )


@router.get("/submissions", response_model=SubmissionListOut)
def list_submissions(
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=MAX_PER_PAGE),
    platform: str | None = Query(None),
    verdict: str | None = Query(None),
) -> SubmissionListOut:
    query = select(Submission).where(Submission.user_id == user.id)
    count_query = select(func.count(Submission.id)).where(Submission.user_id == user.id)
    if platform:
        query = query.where(Submission.platform == platform)
        count_query = count_query.where(Submission.platform == platform)
    if verdict:
        query = query.where(Submission.verdict == verdict)
        count_query = count_query.where(Submission.verdict == verdict)

    total = session.execute(count_query).scalar_one()
    rows = (
        session.execute(
            query.order_by(Submission.detected_at.desc())
            .offset((page - 1) * per_page)
            .limit(per_page)
        )
        .scalars()
        .all()
    )
    return SubmissionListOut(
        items=[SubmissionOut.from_model(r) for r in rows],
        meta=PageMeta(page=page, per_page=per_page, total=total),
    )


@router.get("/submissions/{submission_id}", response_model=SubmissionOut)
def get_submission(
    submission_id: int,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SubmissionOut:
    row = session.execute(
        select(Submission).where(Submission.id == submission_id, Submission.user_id == user.id)
    ).scalar_one_or_none()
    if row is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "Submission not found."},
        )
    return SubmissionOut.from_model(row)


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)

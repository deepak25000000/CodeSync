"""Sync job creation, listing, details and retry."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db_session
from app.logging_utils import log_event
from app.models import JobState, Submission, SubmissionStatus, SyncAttempt, SyncJob, User
from app.schemas import (
    PageMeta,
    SyncCreateIn,
    SyncCreateOut,
    SyncJobDetailOut,
    SyncJobOut,
    SyncListOut,
)

logger = logging.getLogger("codesync.api.sync")

router = APIRouter(tags=["sync"])

MAX_PER_PAGE = 100
TERMINAL_STATES = (JobState.synced.value, JobState.failed.value)


@router.post("/sync", response_model=SyncCreateOut)
async def create_sync(
    body: SyncCreateIn,
    request_session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SyncCreateOut:
    submission = request_session.execute(
        select(Submission).where(Submission.id == body.submission_id, Submission.user_id == user.id)
    ).scalar_one_or_none()
    if submission is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "Submission not found."},
        )
    if submission.status != SubmissionStatus.validated.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "code": "INVALID_VERDICT",
                "message": f"Submission verdict is {submission.verdict}; only accepted "
                "solutions can be synced.",
            },
        )

    existing = request_session.execute(
        select(SyncJob).where(SyncJob.submission_id == submission.id)
    ).scalar_one_or_none()
    if existing is not None:
        if existing.state in TERMINAL_STATES:
            return SyncCreateOut(
                job=SyncJobOut.from_model(existing),
                duplicate=True,
                detail="Job already reached a terminal state; use retry to re-run it.",
            )
        return SyncCreateOut(
            job=SyncJobOut.from_model(existing), duplicate=True, detail="Job already queued."
        )

    job = SyncJob(
        user_id=user.id,
        submission_id=submission.id,
        state=JobState.queued.value,
        max_attempts=5,
    )
    request_session.add(job)
    request_session.flush()
    log_event(logger, "sync_queued", job_id=job.id, submission_id=submission.id)
    return SyncCreateOut(job=SyncJobOut.from_model(job), duplicate=False, detail=None)


@router.post("/sync/{job_id}/retry", response_model=SyncCreateOut)
def retry_sync(
    job_id: int,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SyncCreateOut:
    job = _get_owned_job(session, job_id, user)
    if job.state == JobState.synced.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "ALREADY_SYNCED", "message": "Job already synced successfully."},
        )
    if job.state == JobState.syncing.value:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "IN_PROGRESS", "message": "Job is currently syncing."},
        )
    job.state = JobState.queued.value
    job.next_attempt_at = None
    job.completed_at = None
    log_event(logger, "sync_retried", job_id=job.id, previous_attempts=job.attempts)
    return SyncCreateOut(job=SyncJobOut.from_model(job), duplicate=False, detail="Re-queued.")


@router.get("/sync", response_model=SyncListOut)
def list_jobs(
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
    page: int = Query(1, ge=1),
    per_page: int = Query(20, ge=1, le=MAX_PER_PAGE),
    state: str | None = Query(None),
) -> SyncListOut:
    query = select(SyncJob).where(SyncJob.user_id == user.id)
    count_query = select(func.count(SyncJob.id)).where(SyncJob.user_id == user.id)
    if state:
        query = query.where(SyncJob.state == state)
        count_query = count_query.where(SyncJob.state == state)
    total = session.execute(count_query).scalar_one()
    rows = (
        session.execute(
            query.order_by(SyncJob.created_at.desc()).offset((page - 1) * per_page).limit(per_page)
        )
        .scalars()
        .all()
    )
    return SyncListOut(
        items=[SyncJobOut.from_model(r) for r in rows],
        meta=PageMeta(page=page, per_page=per_page, total=total),
    )


@router.get("/sync/{job_id}", response_model=SyncJobDetailOut)
def get_job(
    job_id: int,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SyncJobDetailOut:
    job = _get_owned_job(session, job_id, user)
    attempts = (
        session.execute(
            select(SyncAttempt).where(SyncAttempt.job_id == job.id).order_by(SyncAttempt.attempt_no)
        )
        .scalars()
        .all()
    )
    base = SyncJobOut.from_model(job)
    return SyncJobDetailOut(
        **base.model_dump(),
        attempts_log=[
            {
                "attempt_no": a.attempt_no,
                "state": a.state,
                "error_code": a.error_code,
                "error_message": a.error_message,
                "http_status": a.http_status,
                "created_at": a.created_at,
            }
            for a in attempts
        ],
    )


def _get_owned_job(session: Session, job_id: int, user: User) -> SyncJob:
    job = session.execute(
        select(SyncJob).where(SyncJob.id == job_id, SyncJob.user_id == user.id)
    ).scalar_one_or_none()
    if job is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "Sync job not found."},
        )
    return job

"""User settings, platform toggles, repository selection, stats and account deletion."""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.deps import get_current_user, get_db_session
from app.logging_utils import log_event
from app.models import (
    JobState,
    PlatformIntegration,
    Submission,
    SyncJob,
    User,
)
from app.platforms import PLATFORMS, platform_matrix
from app.schemas import (
    IntegrationsOut,
    PlatformToggleIn,
    RepoCreateIn,
    RepoListOut,
    RepoOut,
    SettingsOut,
    SettingsUpdateIn,
    StatsOut,
)
from app.security import CredentialCipher
from app.services.auth import AuthError, fetch_github_user, github_connection_active
from app.services.errors import SyncError
from app.services.sync_worker import get_github_token, get_settings_row

logger = logging.getLogger("codesync.api.settings")

router = APIRouter(tags=["settings"])


def _count_map(rows) -> dict[str, int]:
    """Turn [(key, count), ...] rows into a plain dict for the response schema."""
    return {str(row[0]): int(row[1]) for row in rows}


def _settings_out(session: Session, user_id: int) -> SettingsOut:
    row = get_settings_row(session, user_id)
    integrations = (
        session.execute(select(PlatformIntegration).where(PlatformIntegration.user_id == user_id))
        .scalars()
        .all()
    )
    enabled = {i.platform: i.enabled for i in integrations}
    return SettingsOut(
        repo_full_name=row.repo_full_name,
        branch=row.branch,
        root_folder=row.root_folder,
        auto_sync=row.auto_sync,
        github_connected=github_connection_active(session, user_id),
        platforms={pid: enabled.get(pid, True) for pid in PLATFORMS},
    )


@router.get("/settings", response_model=SettingsOut)
def get_settings_endpoint(
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SettingsOut:
    return _settings_out(session, user.id)


@router.patch("/settings", response_model=SettingsOut)
def update_settings(
    body: SettingsUpdateIn,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> SettingsOut:
    row = get_settings_row(session, user.id)
    provided = body.model_fields_set
    if "repo_full_name" in provided:
        # explicit null/"" clears the repository binding
        row.repo_full_name = body.repo_full_name
    if body.branch is not None:
        row.branch = body.branch
    if body.root_folder is not None:
        row.root_folder = body.root_folder
    if body.auto_sync is not None:
        row.auto_sync = body.auto_sync
    log_event(logger, "settings_updated", user_id=user.id, repo=row.repo_full_name)
    return _settings_out(session, user.id)


@router.get("/platforms", response_model=IntegrationsOut)
def list_platforms(
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> IntegrationsOut:
    integrations = (
        session.execute(select(PlatformIntegration).where(PlatformIntegration.user_id == user.id))
        .scalars()
        .all()
    )
    enabled = {i.platform: i.enabled for i in integrations}
    return IntegrationsOut(platforms=platform_matrix(enabled))


@router.put("/platforms/{platform_id}", response_model=IntegrationsOut)
def toggle_platform(
    platform_id: str,
    body: PlatformToggleIn,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> IntegrationsOut:
    if platform_id not in PLATFORMS:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": f"Unknown platform: {platform_id}"},
        )
    row = session.execute(
        select(PlatformIntegration).where(
            PlatformIntegration.user_id == user.id,
            PlatformIntegration.platform == platform_id,
        )
    ).scalar_one_or_none()
    if row is None:
        row = PlatformIntegration(user_id=user.id, platform=platform_id, enabled=body.enabled)
        session.add(row)
    else:
        row.enabled = body.enabled
    session.flush()
    log_event(
        logger, "platform_toggled", user_id=user.id, platform=platform_id, enabled=body.enabled
    )
    return list_platforms(session=session, user=user)


def _github(request: Request, session: Session, user: User):
    settings = request.app.state.settings
    cipher = CredentialCipher(settings.credentials_key)
    token = get_github_token(session, user.id, cipher)
    factory = request.app.state.github_factory
    return factory(token)


@router.get("/repos", response_model=RepoListOut)
async def list_repos(
    request: Request,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
    page: int = Query(1, ge=1),
) -> RepoListOut:
    try:
        async with _github(request, session, user) as gh:
            data = await gh.list_repositories(page=page)
    except SyncError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    items = [
        RepoOut(
            full_name=r.get("full_name", ""),
            name=r.get("name", ""),
            private=bool(r.get("private")),
            default_branch=r.get("default_branch"),
            html_url=r.get("html_url", ""),
            permissions=r.get("permissions"),
        )
        for r in data
        if isinstance(r, dict)
    ]
    return RepoListOut(items=items)


@router.post("/repos", response_model=RepoOut, status_code=status.HTTP_201_CREATED)
async def create_repo(
    body: RepoCreateIn,
    request: Request,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> RepoOut:
    try:
        async with _github(request, session, user) as gh:
            data = await gh.create_repository(body.name, body.description, body.private)
    except SyncError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": exc.code, "message": exc.message},
        ) from exc
    return RepoOut(
        full_name=data.get("full_name", ""),
        name=data.get("name", body.name),
        private=bool(data.get("private")),
        default_branch=data.get("default_branch"),
        html_url=data.get("html_url", ""),
        permissions=data.get("permissions"),
    )


@router.get("/github/connection")
async def github_connection(
    request: Request,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    """Verify the stored GitHub credential still works (identity check only)."""
    settings = request.app.state.settings
    if not github_connection_active(session, user.id):
        return {"connected": False, "github_login": None}
    cipher = CredentialCipher(settings.credentials_key)
    try:
        token = get_github_token(session, user.id, cipher)
        profile = await fetch_github_user(
            token, settings, getattr(request.app.state, "github_transport", None)
        )
    except (SyncError, AuthError):
        return {"connected": False, "github_login": None}
    return {"connected": True, "github_login": profile.get("login")}


@router.get("/stats", response_model=StatsOut)
def stats(
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> StatsOut:
    submissions_total = session.execute(
        select(func.count(Submission.id)).where(Submission.user_id == user.id)
    ).scalar_one()
    accepted_total = session.execute(
        select(func.count(Submission.id)).where(
            Submission.user_id == user.id, Submission.verdict == "accepted"
        )
    ).scalar_one()

    job_rows = session.execute(
        select(SyncJob.state, func.count(SyncJob.id))
        .where(SyncJob.user_id == user.id)
        .group_by(SyncJob.state)
    ).all()
    by_platform = session.execute(
        select(Submission.platform, func.count(Submission.id))
        .where(Submission.user_id == user.id)
        .group_by(Submission.platform)
    ).all()
    synced_rows = session.execute(
        select(Submission.platform, func.count(Submission.id))
        .join(SyncJob, SyncJob.submission_id == Submission.id)
        .where(SyncJob.user_id == user.id, SyncJob.state == JobState.synced.value)
        .group_by(Submission.platform)
    ).all()

    return StatsOut(
        submissions_total=submissions_total,
        accepted_total=accepted_total,
        jobs_by_state=_count_map(job_rows),
        submissions_by_platform=_count_map(by_platform),
        synced_by_platform=_count_map(synced_rows),
    )


@router.delete("/account")
def delete_account(
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict[str, bool]:
    """Irreversibly delete the account and everything tied to it."""
    log_event(logger, "account_deleted", user_id=user.id, github_login=user.github_login)
    session.delete(user)
    session.flush()
    return {"deleted": True}

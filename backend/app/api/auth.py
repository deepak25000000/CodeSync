"""Authentication endpoints: GitHub OAuth, static PAT connection, API tokens."""

from __future__ import annotations

import hashlib
import html
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import HTMLResponse, RedirectResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import Settings
from app.deps import get_app_settings, get_current_user, get_db_session
from app.logging_utils import log_event
from app.models import ApiToken, PlatformIntegration, User, UserSettings
from app.platforms import platform_matrix
from app.schemas import AuthOut, GitHubPatIn, UserOut
from app.services.auth import (
    AuthError,
    authorize_url,
    exchange_oauth_code,
    fetch_github_user,
    issue_api_token,
    store_oauth_state,
    upsert_github_user,
    validate_oauth_state,
)

logger = logging.getLogger("codesync.api.auth")

router = APIRouter(prefix="/auth", tags=["auth"])

STATE_COOKIE = "codesync_oauth_state"


def _client_key(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _rate_check(request: Request, settings: Settings, scope: str) -> None:
    if not settings.rate_limit_enabled:
        return
    limiter = request.app.state.rate_limiter
    allowed, _remaining, retry_after = limiter.check(f"auth:{scope}:{_client_key(request)}")
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail={
                "code": "RATE_LIMITED",
                "message": "Too many attempts; slow down.",
                "retry_after": round(retry_after, 2),
            },
            headers={"Retry-After": str(int(retry_after) + 1)},
        )


def _auth_out(session: Session, user: User, plaintext_token: str) -> AuthOut:
    return AuthOut(
        api_token=plaintext_token,
        user=UserOut(id=user.id, github_login=user.github_login, created_at=user.created_at),
        github_login=user.github_login,
    )


@router.post("/pat", response_model=AuthOut)
async def connect_with_pat(
    body: GitHubPatIn,
    request: Request,
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> AuthOut:
    """Validate a GitHub personal access token and issue a CodeSync API token."""
    _rate_check(request, settings, "pat")
    transport = getattr(request.app.state, "github_transport", None)
    try:
        profile = await fetch_github_user(body.token, settings, transport=transport)
    except AuthError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": exc.message}
        ) from exc
    try:
        user = upsert_github_user(session, profile, body.token, settings, scopes="pat")
    except AuthError as exc:
        raise HTTPException(
            status_code=exc.status_code, detail={"code": exc.code, "message": exc.message}
        ) from exc
    token = issue_api_token(session, user, name="pat")
    log_event(logger, "pat_connected", user_id=user.id, github_login=user.github_login)
    return _auth_out(session, user, token)


@router.get("/github/start")
async def github_oauth_start(
    request: Request, settings: Settings = Depends(get_app_settings)
) -> RedirectResponse:
    if not settings.oauth_enabled:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail={
                "code": "OAUTH_NOT_CONFIGURED",
                "message": "GitHub OAuth is not configured; use a personal access token.",
            },
        )
    _rate_check(request, settings, "oauth-start")
    import secrets

    state = secrets.token_urlsafe(24)
    state_hash = hashlib.sha256(state.encode()).hexdigest()
    store_oauth_state(request.app.state.oauth_states, state_hash)
    response = RedirectResponse(authorize_url(settings, state), status_code=302)
    response.set_cookie(
        STATE_COOKIE,
        state,
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=settings.public_base_url.startswith("https://"),
    )
    return response


@router.get("/github/callback", response_class=HTMLResponse)
async def github_oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    session: Session = Depends(get_db_session),
    settings: Settings = Depends(get_app_settings),
) -> HTMLResponse:
    if error or not code:
        return _portal_result(False, f"GitHub sign-in failed: {error or 'missing code'}")
    cookie_state = request.cookies.get(STATE_COOKIE)
    state_hash = hashlib.sha256((state or "").encode()).hexdigest()
    valid = bool(cookie_state and state == cookie_state) and validate_oauth_state(
        request.app.state.oauth_states, state_hash
    )
    if not valid:
        return _portal_result(False, "Invalid or expired OAuth state; please try again.")

    transport = getattr(request.app.state, "github_transport", None)
    try:
        token_data = await exchange_oauth_code(code, settings, transport=transport)
        profile = await fetch_github_user(token_data["access_token"], settings, transport=transport)
        user = upsert_github_user(
            session,
            profile,
            token_data["access_token"],
            settings,
            scopes=token_data.get("scope", ""),
        )
    except AuthError as exc:
        log_event(logger, "oauth_failed", level=logging.WARNING, code=exc.code)
        return _portal_result(False, exc.message)

    plaintext = issue_api_token(session, user, name="oauth")
    log_event(logger, "oauth_connected", user_id=user.id, github_login=user.github_login)
    response = _portal_result(True, None, token=plaintext, login=user.github_login)
    response.delete_cookie(STATE_COOKIE)
    return response


@router.post("/token", response_model=AuthOut)
def mint_api_token(
    request: Request,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> AuthOut:
    """Issue an additional API token for the authenticated user (token rotation)."""
    _rate_check(request, get_app_settings(request), "mint")
    token = issue_api_token(session, user, name="rotated")
    return _auth_out(session, user, token)


@router.get("/me")
def me(
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    settings_row = session.get(UserSettings, user.id)
    integrations = (
        session.execute(select(PlatformIntegration).where(PlatformIntegration.user_id == user.id))
        .scalars()
        .all()
    )
    enabled_map = {i.platform: i.enabled for i in integrations}
    from app.services.auth import github_connection_active

    return {
        "id": user.id,
        "github_login": user.github_login,
        "created_at": user.created_at,
        "github_connected": github_connection_active(session, user.id),
        "settings": {
            "repo_full_name": settings_row.repo_full_name if settings_row else None,
            "branch": (settings_row.branch if settings_row else "main"),
            "root_folder": (settings_row.root_folder if settings_row else "DSA-Solutions"),
            "auto_sync": (settings_row.auto_sync if settings_row else True),
        },
        "platforms": [
            {
                "id": p["id"],
                "name": p["name"],
                "enabled": enabled_map.get(p["id"], True),
            }
            for p in platform_matrix()
        ],
    }


@router.get("/tokens")
def list_tokens(
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    rows = (
        session.execute(
            select(ApiToken).where(ApiToken.user_id == user.id, ApiToken.revoked_at.is_(None))
        )
        .scalars()
        .all()
    )
    return {
        "items": [
            {
                "id": r.id,
                "name": r.name,
                "created_at": r.created_at,
                "last_used_at": r.last_used_at,
                # never expose the token or its hash
                "prefix": "cs_…",
            }
            for r in rows
        ]
    }


@router.delete("/tokens/{token_id}")
def revoke_token(
    token_id: int,
    session: Session = Depends(get_db_session),
    user: User = Depends(get_current_user),
) -> dict:
    row = session.get(ApiToken, token_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={"code": "NOT_FOUND", "message": "Token not found."},
        )
    row.revoked_at = datetime.now(UTC)
    return {"revoked": True}


def _portal_result(
    ok: bool, message: str | None, token: str | None = None, login: str | None = None
) -> HTMLResponse:
    """Tiny result page (the only HTML the backend serves): shows the one-time token."""
    if ok and token:
        body = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>CodeSync — connected</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:64px auto;padding:0 16px;color:#111}}
code{{display:block;background:#f4f4f5;padding:12px;border-radius:8px;word-break:break-all;margin:12px 0}}
.btn{{display:inline-block;background:#111;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none}}
.warn{{background:#fff7ed;border:1px solid #fdba74;padding:10px;border-radius:8px}}</style></head>
<body><h1>Connected as <code style="display:inline;background:none;padding:0">{html.escape(login or "")}</code></h1>
<p class="warn">Copy this API token now — it is shown only once. Paste it into the CodeSync extension options page.</p>
<code id="token">{html.escape(token)}</code>
<p><button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('token').textContent)">Copy token</button></p>
<p>Then close this tab and return to the extension.</p></body></html>"""
    else:
        body = f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>CodeSync — error</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:640px;margin:64px auto;padding:0 16px}}</style>
</head><body><h1>Connection failed</h1><p>{html.escape(message or "Unknown error")}</p>
<p><a href="/">Back to portal</a></p></body></html>"""
    return HTMLResponse(body, status_code=200 if ok else 400)

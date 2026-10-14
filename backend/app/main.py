"""FastAPI application factory: middleware, lifespan, routers, portal page."""

from __future__ import annotations

import html
import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, JSONResponse

from app.api import auth, health, submissions, sync
from app.api import settings as settings_api
from app.config import Settings, get_settings
from app.db import Database
from app.logging_utils import request_id_var, setup_logging
from app.platforms import platform_matrix
from app.ratelimit import SlidingWindowRateLimiter
from app.services.sync_worker import SyncScheduler

logger = logging.getLogger("codesync.app")

API_DOCS_TITLE = "CodeSync API"


def build_github_factory(settings: Settings, transport=None):
    from app.services.github import GitHubClient

    def factory(token: str) -> GitHubClient:
        return GitHubClient(
            token=token,
            base_url=settings.github_api_base_url,
            timeout=settings.github_timeout_seconds,
            transport=transport,
        )

    return factory


def create_app(settings: Settings | None = None, transport=None) -> FastAPI:
    settings = settings or get_settings()
    setup_logging(settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        db: Database = app.state.db
        db.create_all()
        if settings.sync_scheduler_enabled:
            await app.state.sync_scheduler.start()
        logger.info("codesync_started", extra={"extra_fields": {"env": settings.environment}})
        try:
            yield
        finally:
            if settings.sync_scheduler_enabled:
                await app.state.sync_scheduler.stop()

    app = FastAPI(
        title=API_DOCS_TITLE,
        version="1.0.0",
        description="Accepted-solution ingestion and GitHub synchronization API.",
        lifespan=lifespan,
        docs_url="/docs",
        redoc_url="/redoc",
    )

    app.state.settings = settings
    app.state.db = Database(settings.database_url)
    app.state.rate_limiter = SlidingWindowRateLimiter(
        settings.rate_limit_requests, settings.rate_limit_window_seconds
    )
    app.state.github_transport = transport
    app.state.github_factory = build_github_factory(settings, transport)
    app.state.oauth_states = {}
    app.state.sync_scheduler = SyncScheduler(
        app.state.db, settings, github_factory=app.state.github_factory
    )

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=False,
            allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
            allow_headers=["Authorization", "Content-Type", "X-Request-Id"],
        )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("X-Request-Id") or uuid.uuid4().hex[:16]
        token = request_id_var.set(rid)
        try:
            declared = request.headers.get("content-length")
            if declared and declared.isdigit() and int(declared) > settings.max_request_bytes:
                return JSONResponse(
                    status_code=413,
                    content={
                        "detail": {
                            "code": "PAYLOAD_TOO_LARGE",
                            "message": "Request body too large.",
                        }
                    },
                )
            response = await call_next(request)
            response.headers["X-Request-Id"] = rid
            response.headers["X-Content-Type-Options"] = "nosniff"
            response.headers["Referrer-Policy"] = "no-referrer"
            return response
        finally:
            request_id_var.reset(token)

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        logging.getLogger("codesync.api").exception(
            "unhandled_error", extra={"extra_fields": {"path": request.url.path}}
        )
        return JSONResponse(
            status_code=500,
            content={"detail": {"code": "INTERNAL", "message": "Internal server error."}},
        )

    prefix = settings.api_prefix
    app.include_router(health.router, prefix=prefix)
    app.include_router(auth.router, prefix=prefix)
    app.include_router(submissions.router, prefix=prefix)
    app.include_router(sync.router, prefix=prefix)
    app.include_router(settings_api.router, prefix=prefix)

    @app.get("/", response_class=HTMLResponse, include_in_schema=False)
    def portal() -> str:
        return _portal_page(settings, platform_matrix())

    return app


def _portal_page(settings: Settings, platforms: list[dict]) -> str:
    platform_rows = "".join(
        f"<li><b>{html.escape(p['name'])}</b> — "
        f"{html.escape(p['capabilities'].get('notes', '')[:120])}</li>"
        for p in platforms
    )
    oauth_block = (
        f'<p><a class="btn" href="{settings.api_prefix}/auth/github/start">Sign in with GitHub</a></p>'
        if settings.oauth_enabled
        else '<p class="muted">OAuth is not configured — connect with a personal access token below.</p>'
    )
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CodeSync</title>
<style>
:root{{--bg:#0b0d10;--card:#14171c;--fg:#e7e9ee;--mut:#9aa3b2;--acc:#4f8cff;--ok:#37d399;--err:#ff6b6b}}
*{{box-sizing:border-box}} body{{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,sans-serif}}
main{{max-width:760px;margin:0 auto;padding:48px 20px}}
h1{{font-size:28px;margin:0 0 4px}} h2{{font-size:17px;margin:28px 0 8px}}
.card{{background:var(--card);border:1px solid #23262d;border-radius:12px;padding:18px 20px;margin-top:14px}}
.btn{{display:inline-block;background:var(--acc);color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;border:0;font-size:14px;cursor:pointer}}
.btn:hover{{filter:brightness(1.08)}}
input,textarea,select{{width:100%;background:#0e1116;border:1px solid #2a2e36;color:var(--fg);border-radius:8px;padding:9px 11px;font-size:14px;margin:6px 0 12px}}
label{{font-size:13px;color:var(--mut)}}
.muted{{color:var(--mut);font-size:14px}} .ok{{color:var(--ok)}} .err{{color:var(--err)}}
code#token{{display:block;background:#0e1116;border:1px solid #2a2e36;padding:12px;border-radius:8px;word-break:break-all;margin:10px 0}}
ul{{padding-left:18px}} li{{margin:3px 0;color:var(--mut);font-size:14px}}
.step{{display:flex;gap:10px;align-items:flex-start;margin:8px 0}}
.step b{{color:var(--acc)}}
</style></head><body><main>
<h1>CodeSync</h1>
<p class="muted">Sync accepted solutions from LeetCode, GeeksforGeeks &amp; CodeChef straight into your GitHub repository.</p>

<div class="card">
 <h2 style="margin-top:0">1 · Connect GitHub</h2>
 {oauth_block}
 <details><summary class="muted" style="cursor:pointer">Use a personal access token instead</summary>
  <label for="pat">GitHub PAT (scopes: <code>repo</code>)</label>
  <input id="pat" type="password" placeholder="ghp_…" autocomplete="off">
  <button class="btn" id="patBtn">Connect with PAT</button>
 </details>
 <div id="tokenBox" style="display:none">
  <h2>2 · Copy your API token</h2>
  <p class="muted">Shown once. Paste it into the CodeSync extension → Options.</p>
  <code id="token"></code>
  <button class="btn" id="copyBtn">Copy token</button>
 </div>
</div>

<div class="card">
 <h2 style="margin-top:0">3 · Install the extension</h2>
 <div class="step"><b>a.</b><span>Run <code>npm run build</code> in <code>extension/</code>, then load <code>extension/dist</code> via <code>chrome://extensions → Load unpacked</code>.</span></div>
 <div class="step"><b>b.</b><span>Open the extension Options, set API base URL (<code>{html.escape(settings.public_base_url)}</code>) and paste the API token.</span></div>
 <div class="step"><b>c.</b><span>Pick a repository, then submit a problem — the solution lands in your repo automatically.</span></div>
</div>

<div class="card">
 <h2 style="margin-top:0">Supported platforms</h2>
 <ul>{platform_rows}</ul>
</div>

<div class="card">
 <h2 style="margin-top:0">API</h2>
 <p class="muted">Interactive docs at <a class="ok" href="/docs">/docs</a> · health at <a class="ok" href="{settings.api_prefix}/health">{settings.api_prefix}/health</a></p>
</div>

<div id="msg" class="muted"></div>
</main>
<script>
const API = "{settings.api_prefix}";
const msg = (t, cls) => {{ const m = document.getElementById('msg'); m.textContent = t; m.className = cls || 'muted'; }};
document.getElementById('patBtn').addEventListener('click', async () => {{
  const token = document.getElementById('pat').value.trim();
  if (!token) return msg('Enter a GitHub personal access token first.', 'err');
  msg('Validating token…');
  try {{
    const r = await fetch(API + '/auth/pat', {{
      method: 'POST', headers: {{'Content-Type': 'application/json'}},
      body: JSON.stringify({{token}})
    }});
    const data = await r.json();
    if (!r.ok) throw new Error((data.detail && data.detail.message) || ('HTTP ' + r.status));
    showToken(data.api_token);
    msg('Connected as ' + data.github_login + '.', 'ok');
  }} catch (e) {{ msg(e.message, 'err'); }}
}});
function showToken(t) {{
  const box = document.getElementById('tokenBox');
  box.style.display = 'block';
  document.getElementById('token').textContent = t;
  box.scrollIntoView({{behavior:'smooth'}});
}}
document.getElementById('copyBtn').addEventListener('click', () => {{
  navigator.clipboard.writeText(document.getElementById('token').textContent);
  msg('Token copied to clipboard.', 'ok');
}});
</script>
</body></html>"""


app = create_app()


def run() -> None:  # pragma: no cover - manual entrypoint
    import uvicorn

    uvicorn.run("app.main:app", host="127.0.0.1", port=8000, reload=False)


if __name__ == "__main__":  # pragma: no cover
    run()

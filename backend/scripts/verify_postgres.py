"""Verify the backend end-to-end against a real PostgreSQL database.

Usage (from backend/):

    DATABASE_URL=postgres://user:pass@host:5432/dbname .venv/Scripts/python scripts/verify_postgres.py

Checks, in order:
  1. Alembic migrations apply cleanly on Postgres.
  2. The app boots on the engine and the API works (GitHub mocked):
     PAT connect -> /auth/me -> /settings.
  3. The data really landed in the Postgres tables.

Run this against your Neon/Supabase connection string before pointing the
extension at a hosted deployment. SQLite remains the default for dev/tests;
this script is the Postgres equivalent of "pytest" for the hosted path.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import httpx

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


def main() -> int:
    database_url = os.environ.get("DATABASE_URL", "")
    if not database_url.startswith(("postgres://", "postgresql://")):
        print("Set DATABASE_URL to a postgres://… connection string first.")
        return 2

    print("1/3 applying alembic migrations on Postgres …")
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        cwd=BACKEND_ROOT,
        env={**os.environ},
        check=True,
    )

    print("2/3 booting the app and exercising the API (GitHub mocked) …")
    from fastapi.testclient import TestClient

    from app.config import Settings
    from app.main import create_app

    def fake_github(request: httpx.Request) -> httpx.Response:
        if request.url.host == "api.github.com" and request.url.path == "/user":
            return httpx.Response(200, json={"login": "pg_smoke", "id": 424242, "name": "PG Smoke"})
        return httpx.Response(404, json={"message": "not mocked"})

    settings = Settings(
        _env_file=None,
        database_url=database_url,
        credentials_key="pg-smoke-verification-key",
        environment="test",
        sync_scheduler_enabled=False,
    )
    app = create_app(settings, transport=httpx.MockTransport(fake_github))
    with TestClient(app) as client:
        headers: dict[str, str] = {}
        resp = client.post("/api/v1/auth/pat", json={"token": "ghp_pg_smoke"})
        assert resp.status_code == 200, f"PAT connect failed on Postgres: {resp.text}"
        headers["Authorization"] = f"Bearer {resp.json()['api_token']}"

        me = client.get("/api/v1/auth/me", headers=headers)
        assert me.status_code == 200, f"/auth/me failed: {me.text}"
        assert me.json()["github_login"] == "pg_smoke"

        settings_resp = client.get("/api/v1/settings", headers=headers)
        assert settings_resp.status_code == 200, f"/settings failed: {settings_resp.text}"

    print("3/3 checking the data landed in Postgres …")
    from sqlalchemy import text

    from app.db import Database

    db = Database(database_url)
    with db.session() as session:
        users = session.execute(text("select count(*) from users")).scalar()
        tokens = session.execute(text("select count(*) from api_tokens")).scalar()
    assert users and tokens, "expected rows in users/api_tokens"

    print(f"OK — migrations + full API verified on Postgres (users={users}, tokens={tokens}).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

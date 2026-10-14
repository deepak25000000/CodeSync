"""Migration tests: upgrade/downgrade round-trip against a throwaway database."""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _alembic(db_path: Path, *args: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "DATABASE_URL": f"sqlite:///{db_path}"}
    return subprocess.run(
        [sys.executable, "-m", "alembic", *args],
        cwd=BACKEND_ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=120,
    )


def _tables(db_path: Path) -> set[str]:
    con = sqlite3.connect(db_path)
    try:
        rows = con.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        ).fetchall()
    finally:
        con.close()
    return {r[0] for r in rows}


EXPECTED_TABLES = {
    "users",
    "oauth_connections",
    "api_tokens",
    "user_settings",
    "platform_integrations",
    "submissions",
    "sync_jobs",
    "sync_attempts",
    "alembic_version",
}


def test_upgrade_creates_schema(tmp_path: Path):
    db = tmp_path / "migrate.db"
    result = _alembic(db, "upgrade", "head")
    assert result.returncode == 0, result.stderr
    assert EXPECTED_TABLES.issubset(_tables(db))


def test_no_pending_model_changes(tmp_path: Path):
    """`alembic check` fails when models and migrations drift apart."""
    db = tmp_path / "migrate.db"
    assert _alembic(db, "upgrade", "head").returncode == 0
    result = _alembic(db, "check")
    assert result.returncode == 0, result.stdout + result.stderr


def test_downgrade_removes_schema(tmp_path: Path):
    db = tmp_path / "migrate.db"
    assert _alembic(db, "upgrade", "head").returncode == 0
    result = _alembic(db, "downgrade", "base")
    assert result.returncode == 0, result.stderr
    assert _tables(db) == {"alembic_version"} or not _tables(db)


def test_upgrade_is_idempotent(tmp_path: Path):
    db = tmp_path / "migrate.db"
    assert _alembic(db, "upgrade", "head").returncode == 0
    again = _alembic(db, "upgrade", "head")
    assert again.returncode == 0, again.stderr

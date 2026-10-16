"""Unit tests for database URL handling (SQLite default + hosted Postgres)."""

from app.db import normalize_database_url


class TestNormalizeDatabaseUrl:
    def test_postgres_scheme_gets_psycopg2_driver(self):
        # Neon/Supabase hand out plain postgres:// URLs — paste as-is must work.
        url = "postgres://codesync_owner:secret@ep-abc.aws.neon.tech/neondb?sslmode=require"
        out = normalize_database_url(url)
        assert out.startswith("postgresql+psycopg2://")
        assert "ep-abc.aws.neon.tech/neondb?sslmode=require" in out

    def test_bare_postgresql_scheme_gets_driver(self):
        assert normalize_database_url("postgresql://user:pw@localhost/db") == (
            "postgresql+psycopg2://user:pw@localhost/db"
        )

    def test_explicit_driver_is_preserved(self):
        url = "postgresql+asyncpg://user:pw@localhost/db"
        assert normalize_database_url(url) == url

    def test_sqlite_urls_are_untouched(self):
        assert normalize_database_url("sqlite:///./codesync.db") == "sqlite:///./codesync.db"
        assert normalize_database_url("sqlite://") == "sqlite://"

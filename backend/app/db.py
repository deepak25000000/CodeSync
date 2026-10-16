from collections.abc import Iterator
from contextlib import contextmanager

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker


class Base(DeclarativeBase):
    pass


def normalize_database_url(database_url: str) -> str:
    """Accept the plain ``postgres://`` URLs hosted databases hand out.

    Neon, Supabase and friends return ``postgres://user:pass@host/db?sslmode=…``
    with no driver in the scheme. SQLAlchemy needs ``postgresql+<driver>://``,
    so hosted deployments can paste their connection string as-is.
    """
    if database_url.startswith("postgres://"):
        return database_url.replace("postgres://", "postgresql+psycopg2://", 1)
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+psycopg2://", 1)
    return database_url


def _make_engine(database_url: str) -> Engine:
    database_url = normalize_database_url(database_url)
    connect_args = {}
    if database_url.startswith("sqlite"):
        # Needed for FastAPI/pytest threads sharing the same in-memory or file DB.
        connect_args["check_same_thread"] = False
    engine = create_engine(database_url, connect_args=connect_args, future=True)

    if database_url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _fk_on(dbapi_conn, _record):  # pragma: no cover - trivial pragma
            cur = dbapi_conn.cursor()
            cur.execute("PRAGMA foreign_keys=ON")
            cur.close()

    return engine


class Database:
    """Holds the engine and session factory for the application."""

    def __init__(self, database_url: str) -> None:
        self.engine = _make_engine(database_url)
        self.session_factory = sessionmaker(bind=self.engine, expire_on_commit=False, future=True)

    @contextmanager
    def session(self) -> Iterator[Session]:
        session = self.session_factory()
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()

    def create_all(self) -> None:
        from app import models  # noqa: F401  (ensure models are registered)

        Base.metadata.create_all(self.engine)

    def drop_all(self) -> None:
        from app import models  # noqa: F401

        Base.metadata.drop_all(self.engine)

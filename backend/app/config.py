from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment / .env (never from source)."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "CodeSync"
    environment: str = "development"
    api_prefix: str = "/api/v1"

    # SQLite by default so local dev and tests need no external services.
    database_url: str = "sqlite:///./codesync.db"

    # Server-side encryption key for stored GitHub credentials (Fernet, urlsafe base64, 32 bytes).
    credentials_key: str = ""

    # GitHub OAuth application (optional; PAT flow works without it).
    github_client_id: str = ""
    github_client_secret: str = ""
    github_oauth_scopes: str = "repo"
    # Public base URL used to build the OAuth callback URL, e.g. https://example.com
    public_base_url: str = "http://127.0.0.1:8000"

    # GitHub API
    github_api_base_url: str = "https://api.github.com"
    github_oauth_base_url: str = "https://github.com"
    github_timeout_seconds: float = 15.0

    # Sync worker
    sync_max_attempts: int = 5
    sync_poll_interval_seconds: float = 2.0
    sync_scheduler_enabled: bool = True

    # Rate limiting (per API token, sliding window)
    rate_limit_enabled: bool = True
    rate_limit_requests: int = 120
    rate_limit_window_seconds: int = 60

    # Request safety
    max_request_bytes: int = 2_000_000
    cors_origins: str = ""

    log_level: str = "INFO"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def oauth_enabled(self) -> bool:
        return bool(self.github_client_id and self.github_client_secret)


@lru_cache
def get_settings() -> Settings:
    return Settings()

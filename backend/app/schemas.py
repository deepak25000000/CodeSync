"""Pydantic request/response schemas (OpenAPI contracts)."""

from __future__ import annotations

import re
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

PlatformLiteral = Literal["leetcode", "geeksforgeeks", "codechef", "neetcode"]
VerdictLiteral = Literal["accepted", "rejected", "pending", "manual", "unknown"]

REPO_NAME_RE = re.compile(r"^[A-Za-z0-9._\-]+/[A-Za-z0-9._\-]+$")
ROOT_FOLDER_RE = re.compile(r"^[A-Za-z0-9._\- ]{1,100}$")
BRANCH_RE = re.compile(r"^[A-Za-z0-9._\-/]{1,200}$")


class HealthOut(BaseModel):
    status: str
    app: str
    version: str
    environment: str


class GitHubPatIn(BaseModel):
    token: str = Field(min_length=10, max_length=200, description="GitHub personal access token")


class UserOut(BaseModel):
    id: int
    github_login: str
    created_at: datetime


class AuthOut(BaseModel):
    api_token: str
    user: UserOut
    github_login: str


class SubmissionCreateIn(BaseModel):
    platform: PlatformLiteral
    title: str = Field(min_length=1, max_length=500)
    language: str = Field(min_length=1, max_length=64)
    code: str | None = Field(default=None, max_length=500_000)
    external_id: str | None = Field(default=None, max_length=120)
    problem_id: str | None = Field(default=None, max_length=120)
    url: str | None = Field(default=None, max_length=1000)
    verdict: VerdictLiteral = "unknown"
    submitted_at: datetime | None = None
    metadata: dict[str, Any] | None = None
    auto_sync: bool | None = Field(
        default=None, description="Override the user's auto-sync preference for this submission"
    )

    @field_validator("url")
    @classmethod
    def _url_scheme(cls, v: str | None) -> str | None:
        if v is None:
            return v
        if not v.startswith(("http://", "https://")):
            raise ValueError("url must be http(s)")
        return v


class SubmissionOut(BaseModel):
    id: int
    platform: str
    external_id: str | None
    problem_id: str | None
    title: str
    url: str | None
    language: str
    verdict: str
    status: str
    submitted_at: datetime | None
    detected_at: datetime
    fingerprint: str
    created_at: datetime | None = None

    @classmethod
    def from_model(cls, m: Any) -> SubmissionOut:
        return cls(
            id=m.id,
            platform=m.platform,
            external_id=m.external_id,
            problem_id=m.problem_id,
            title=m.title,
            url=m.url,
            language=m.language,
            verdict=m.verdict,
            status=m.status,
            submitted_at=m.submitted_at,
            detected_at=m.detected_at,
            fingerprint=m.fingerprint,
        )


class SubmissionCreateOut(BaseModel):
    submission: SubmissionOut
    duplicate: bool
    sync_job_id: int | None = None


class PageMeta(BaseModel):
    page: int
    per_page: int
    total: int


class SubmissionListOut(BaseModel):
    items: list[SubmissionOut]
    meta: PageMeta


class SyncCreateIn(BaseModel):
    submission_id: int


class SyncJobOut(BaseModel):
    id: int
    submission_id: int
    state: str
    attempts: int
    max_attempts: int
    error_code: str | None
    last_error: str | None
    file_path: str | None
    commit_sha: str | None
    repo_full_name: str | None
    branch: str | None
    skipped_duplicate: bool
    created_at: datetime
    updated_at: datetime
    completed_at: datetime | None

    @classmethod
    def from_model(cls, m: Any) -> SyncJobOut:
        return cls(
            id=m.id,
            submission_id=m.submission_id,
            state=m.state,
            attempts=m.attempts,
            max_attempts=m.max_attempts,
            error_code=m.error_code,
            last_error=m.last_error,
            file_path=m.file_path,
            commit_sha=m.commit_sha,
            repo_full_name=m.repo_full_name,
            branch=m.branch,
            skipped_duplicate=m.skipped_duplicate,
            created_at=m.created_at,
            updated_at=m.updated_at,
            completed_at=m.completed_at,
        )


class SyncCreateOut(BaseModel):
    job: SyncJobOut | None
    duplicate: bool
    detail: str | None = None


class SyncAttemptOut(BaseModel):
    attempt_no: int
    state: str
    error_code: str | None
    error_message: str | None
    http_status: int | None
    created_at: datetime


class SyncJobDetailOut(SyncJobOut):
    attempts_log: list[SyncAttemptOut]


class SyncListOut(BaseModel):
    items: list[SyncJobOut]
    meta: PageMeta


class SettingsOut(BaseModel):
    repo_full_name: str | None
    branch: str
    root_folder: str
    auto_sync: bool
    github_connected: bool
    platforms: dict[str, bool]


class SettingsUpdateIn(BaseModel):
    repo_full_name: str | None = Field(default=None, max_length=255)
    branch: str | None = Field(default=None, max_length=200)
    root_folder: str | None = Field(default=None, max_length=100)
    auto_sync: bool | None = None

    @field_validator("repo_full_name")
    @classmethod
    def _repo(cls, v: str | None) -> str | None:
        if v is None or v == "":
            return None
        if not REPO_NAME_RE.fullmatch(v):
            raise ValueError("repo_full_name must look like 'owner/repo'")
        return v

    @field_validator("branch")
    @classmethod
    def _branch(cls, v: str | None) -> str | None:
        if v is None:
            return None
        if not BRANCH_RE.fullmatch(v) or ".." in v:
            raise ValueError("invalid branch name")
        return v

    @field_validator("root_folder")
    @classmethod
    def _root(cls, v: str | None) -> str | None:
        if v is None:
            return None
        v = v.strip().strip("/")
        if not ROOT_FOLDER_RE.fullmatch(v) or ".." in v:
            raise ValueError("root_folder may only contain letters, digits, spaces, '.', '_', '-'")
        return v


class PlatformToggleIn(BaseModel):
    enabled: bool


class PlatformInfo(BaseModel):
    id: str
    name: str
    enabled: bool
    capabilities: dict[str, Any]


class IntegrationsOut(BaseModel):
    platforms: list[PlatformInfo]


class RepoOut(BaseModel):
    full_name: str
    name: str
    private: bool
    default_branch: str | None
    html_url: str
    permissions: dict[str, Any] | None = None


class RepoListOut(BaseModel):
    items: list[RepoOut]


class RepoCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9._\-]+$")
    description: str = Field(default="Solutions synchronized by CodeSync", max_length=300)
    private: bool = False


class StatsOut(BaseModel):
    submissions_total: int
    accepted_total: int
    jobs_by_state: dict[str, int]
    submissions_by_platform: dict[str, int]
    synced_by_platform: dict[str, int]

"""Shared pytest fixtures: app factory with an injected mock GitHub transport."""

from __future__ import annotations

import base64
import hashlib
import json
import sys
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402


class FakeGitHub:
    """Stateful in-memory GitHub REST fake (contents, repos, user, oauth)."""

    PROFILES = {
        "ghp_alice_token": {"id": 1, "login": "alice", "email": "alice@example.com"},
        "ghp_bob_token": {"id": 2, "login": "bob", "email": "bob@example.com"},
        "ghp_test_token": {"id": 3, "login": "octo", "email": "octo@example.com"},
        "gho_oauth": {"id": 7, "login": "octo", "email": "octo@example.com"},
    }

    def __init__(self) -> None:
        self.files: dict[tuple[str, str, str], bytes] = {}
        self.commits: list[dict] = []
        self.requests: list[tuple[str, str]] = []
        self.contents_status: int | None = None  # failure injection
        self.repos: list[dict] = [
            {
                "full_name": "octo/dsa",
                "name": "dsa",
                "private": False,
                "default_branch": "main",
                "html_url": "https://github.com/octo/dsa",
                "permissions": {"push": True, "pull": True},
            }
        ]

    # -- helpers ----------------------------------------------------------
    def put_file(self, repo: str, path: str, branch: str, content: bytes) -> None:
        self.files[(repo, path, branch)] = content

    def get_file(self, repo: str, path: str, branch: str) -> bytes | None:
        return self.files.get((repo, path, branch))

    def commit_count(self) -> int:
        return len(self.commits)

    # -- httpx handler ----------------------------------------------------
    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        self.requests.append((request.method, path))

        if path == "/login/oauth/access_token":
            form = request.content.decode()
            code = ""
            for pair in form.split("&"):
                if pair.startswith("code="):
                    code = pair[5:]
            if code == "bad":
                return httpx.Response(200, json={"error": "bad_verification_code"})
            return httpx.Response(
                200, json={"access_token": "gho_oauth", "scope": "repo", "token_type": "bearer"}
            )

        auth = request.headers.get("authorization", "")
        token = auth.split(" ", 1)[1] if auth.startswith("Bearer ") else auth[7:]
        profile = self.PROFILES.get(token)
        if profile is None:
            return httpx.Response(401, json={"message": "Bad credentials"})

        if path == "/user":
            return httpx.Response(200, json=profile)

        if path == "/user/repos" and request.method == "GET":
            return httpx.Response(200, json=self.repos)

        if path == "/user/repos" and request.method == "POST":
            data = json.loads(request.content)
            repo = {
                "full_name": f"{profile['login']}/{data['name']}",
                "name": data["name"],
                "private": bool(data.get("private")),
                "default_branch": "main",
                "html_url": f"https://github.com/{profile['login']}/{data['name']}",
                "permissions": {"push": True, "pull": True},
            }
            self.repos.append(repo)
            return httpx.Response(201, json=repo)

        if path.startswith("/repos/") and "/contents/" in path:
            if self.contents_status is not None:
                status = self.contents_status
                return httpx.Response(status, json={"message": f"injected {status}"})
            head, rel = path.split("/contents/", 1)
            repo = head[len("/repos/") :]
            from urllib.parse import unquote

            rel = unquote(rel)
            branch = request.url.params.get("ref", "main")
            key = (repo, rel, branch)
            if request.method == "GET":
                content = self.files.get(key)
                if content is None:
                    return httpx.Response(404, json={"message": "Not Found"})
                return httpx.Response(
                    200,
                    json={
                        "type": "file",
                        "path": rel,
                        "sha": _sha(content),
                        "content": base64.b64encode(content).decode(),
                        "download_url": f"https://raw.example/{repo}/{rel}",
                    },
                )
            data = json.loads(request.content)
            raw = base64.b64decode(data.get("content", ""))
            self.files[key] = raw
            commit = {"sha": hashlib.sha1(f"{repo}{rel}{len(self.commits)}".encode()).hexdigest()}
            self.commits.append({"repo": repo, "path": rel, "message": data.get("message", "")})
            return httpx.Response(
                201, json={"commit": commit, "content": {"sha": _sha(raw), "path": rel}}
            )

        if path == "/rate_limit":
            return httpx.Response(200, json={"resources": {}})

        return httpx.Response(404, json={"message": f"no route for {path}"})


def _sha(content: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(content)).encode() + b"\0" + content).hexdigest()


def make_settings(tmp_path: Path, **overrides) -> Settings:
    defaults = {
        "environment": "test",
        "database_url": f"sqlite:///{tmp_path / 'test.db'}",
        "credentials_key": "unit-test-key",
        "rate_limit_enabled": False,
        "sync_scheduler_enabled": False,
        "github_client_id": "",
        "github_client_secret": "",
        "public_base_url": "http://127.0.0.1:8000",
        "log_level": "WARNING",
    }
    defaults.update(overrides)
    return Settings(**defaults)


@pytest.fixture
def fake_github() -> FakeGitHub:
    return FakeGitHub()


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
def app(settings: Settings, fake_github: FakeGitHub):
    application = create_app(settings, transport=httpx.MockTransport(fake_github.handler))
    return application


@pytest.fixture
def client(app):
    with TestClient(app, follow_redirects=False) as test_client:
        yield test_client


@pytest.fixture
def token(client: TestClient) -> str:
    """Connect a GitHub account via PAT and return its CodeSync API token."""
    resp = client.post("/api/v1/auth/pat", json={"token": "ghp_test_token"})
    assert resp.status_code == 200, resp.text
    return resp.json()["api_token"]


@pytest.fixture
def auth_headers(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def drain(app) -> int:
    """Run the sync scheduler synchronously (all due jobs)."""
    import asyncio

    return asyncio.run(app.state.sync_scheduler.drain())

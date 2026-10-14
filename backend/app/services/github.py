"""Minimal GitHub REST (Contents API) client with rate-limit awareness."""

from __future__ import annotations

import base64
import logging
from typing import Any

import httpx

from app.logging_utils import log_event
from app.services.errors import (
    ClassifiedError,
    SyncError,
    classify_github_status,
    classify_network_error,
)

logger = logging.getLogger("codesync.github")

REPO_PERMISSIONS = {"contents": "write", "metadata": "read"}


def b64encode(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def b64decode(data: str) -> bytes:
    return base64.b64decode(data)


class GitHubClient:
    """Thin async wrapper over the GitHub REST API.

    A custom ``httpx.AsyncBaseTransport`` (e.g. MockTransport) can be injected so
    tests never touch the network.
    """

    def __init__(
        self,
        token: str,
        base_url: str = "https://api.github.com",
        timeout: float = 15.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._token = token
        self.base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self.base_url,
            timeout=timeout,
            transport=transport,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "User-Agent": "CodeSync",
            },
        )
        self.rate_limit_remaining: int | None = None
        self.rate_limit_reset: float | None = None

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> GitHubClient:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def _request(
        self,
        method: str,
        path: str,
        *,
        json_body: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
        expected: tuple[int, ...] = (200, 201),
    ) -> httpx.Response:
        try:
            resp = await self._client.request(method, path, json=json_body, params=params)
        except httpx.HTTPError as exc:
            raise classify_network_error(exc) from exc

        remaining = resp.headers.get("x-ratelimit-remaining")
        if remaining is not None:
            try:
                self.rate_limit_remaining = int(remaining)
            except ValueError:
                pass
        reset = resp.headers.get("x-ratelimit-reset")
        if reset is not None:
            try:
                self.rate_limit_reset = float(reset)
            except ValueError:
                pass

        if resp.status_code not in expected:
            try:
                body: dict | str | None = resp.json()
            except ValueError:
                body = resp.text
            err = classify_github_status(resp.status_code, body, dict(resp.headers))
            log_event(
                logger,
                "github_api_error",
                level=logging.WARNING,
                method=method,
                path=path,
                status=resp.status_code,
                code=err.code,
            )
            raise err
        return resp

    # ------------------------------------------------------------------ user
    async def get_authenticated_user(self) -> dict[str, Any]:
        resp = await self._request("GET", "/user")
        return resp.json()

    # ----------------------------------------------------------- repositories
    async def list_repositories(self, per_page: int = 100, page: int = 1) -> list[dict[str, Any]]:
        resp = await self._request(
            "GET",
            "/user/repos",
            params={
                "per_page": per_page,
                "page": page,
                "sort": "updated",
                "affiliation": "owner,collaborator,organization_member",
            },
        )
        data = resp.json()
        return data if isinstance(data, list) else []

    async def create_repository(
        self, name: str, description: str = "", private: bool = False
    ) -> dict[str, Any]:
        resp = await self._request(
            "POST",
            "/user/repos",
            json_body={
                "name": name,
                "description": description,
                "private": private,
                "auto_init": True,
            },
        )
        return resp.json()

    # --------------------------------------------------------------- contents
    async def get_file(self, repo_full_name: str, path: str, ref: str) -> dict[str, Any] | None:
        """Return file metadata (incl. sha and base64 content) or None when missing."""
        try:
            resp = await self._request(
                "GET", f"/repos/{repo_full_name}/contents/{_quote(path)}", params={"ref": ref}
            )
        except SyncError as exc:
            if exc.code == "NOT_FOUND" and exc.http_status == 404:
                return None
            raise
        data = resp.json()
        if isinstance(data, dict) and data.get("type") == "file":
            return data
        return None

    async def put_file(
        self,
        repo_full_name: str,
        path: str,
        content: bytes,
        message: str,
        branch: str,
        sha: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "message": message,
            "content": b64encode(content),
            "branch": branch,
        }
        if sha:
            payload["sha"] = sha
        resp = await self._request(
            "PUT", f"/repos/{repo_full_name}/contents/{_quote(path)}", json_body=payload
        )
        data = resp.json()
        commit = data.get("commit", {}) if isinstance(data, dict) else {}
        return {
            "commit_sha": commit.get("sha"),
            "content_sha": (data.get("content") or {}).get("sha")
            if isinstance(data, dict)
            else None,
            "download_url": (data.get("content") or {}).get("download_url")
            if isinstance(data, dict)
            else None,
        }

    async def get_rate_limit(self) -> dict[str, Any]:
        try:
            resp = await self._request("GET", "/rate_limit")
        except ClassifiedError:
            return {}
        return resp.json()


def _quote(path: str) -> str:
    from urllib.parse import quote

    return quote(path, safe="/")

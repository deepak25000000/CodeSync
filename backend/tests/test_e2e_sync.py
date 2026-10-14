"""End-to-end: submission -> scheduler -> GitHub (mocked) with dedupe and failure paths."""

from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from tests.conftest import drain
from tests.test_api_submissions import make_body


def _connect_and_configure(
    client: TestClient, headers: dict, repo: str | None = "octo/dsa"
) -> None:
    if repo:
        resp = client.patch("/api/v1/settings", json={"repo_full_name": repo}, headers=headers)
        assert resp.status_code == 200, resp.text


class TestHappyPath:
    def test_full_sync_writes_file_progress_and_readme(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        _connect_and_configure(client, auth_headers)
        client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)

        processed = drain(app)
        assert processed == 1

        job = client.get("/api/v1/sync", headers=auth_headers).json()["items"][0]
        assert job["state"] == "SYNCED"
        assert job["repo_full_name"] == "octo/dsa"
        assert job["branch"] == "main"
        assert job["file_path"] == "DSA-Solutions/LeetCode/0001-two-sum.py"
        assert job["commit_sha"]

        solution = fake_github.get_file("octo/dsa", job["file_path"], "main")
        assert solution is not None
        text = solution.decode()
        assert "codesync-fp:" in text and "Problem: Two Sum" in text
        assert "class Solution" in text

        progress = fake_github.get_file("octo/dsa", "DSA-Solutions/progress.json", "main")
        assert progress is not None
        assert b'"fingerprint"' in progress

        readme = fake_github.get_file("octo/dsa", "DSA-Solutions/README.md", "main")
        assert readme is not None and b"CodeSync Progress" in readme

        assert fake_github.commit_count() == 3  # solution + progress + readme

    def test_replayed_submission_never_commits_twice(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        _connect_and_configure(client, auth_headers)
        client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)
        drain(app)
        commits_after_first = fake_github.commit_count()

        replay = client.post("/api/v1/submissions", json=make_body(), headers=auth_headers).json()
        assert replay["duplicate"] is True
        processed = drain(app)
        assert processed == 0  # job already SYNCED, nothing queued
        assert fake_github.commit_count() == commits_after_first

    def test_second_problem_creates_second_file(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        _connect_and_configure(client, auth_headers)
        client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)
        drain(app)
        client.post(
            "/api/v1/submissions",
            json=make_body(
                external_id="1002",
                problem_id="2",
                title="Add Two Numbers",
                url="https://leetcode.com/problems/add-two-numbers/",
            ),
            headers=auth_headers,
        )
        drain(app)
        assert fake_github.get_file("octo/dsa", "DSA-Solutions/LeetCode/0001-two-sum.py", "main")
        assert fake_github.get_file(
            "octo/dsa", "DSA-Solutions/LeetCode/0002-add-two-numbers.py", "main"
        )


class TestFailurePaths:
    def test_no_repository_fails_permanently(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        sid = client.post("/api/v1/submissions", json=make_body(), headers=auth_headers).json()[
            "submission"
        ]["id"]
        job_id = client.post(
            "/api/v1/sync", json={"submission_id": sid}, headers=auth_headers
        ).json()["job"]["id"]
        drain(app)
        job = client.get(f"/api/v1/sync/{job_id}", headers=auth_headers).json()
        assert job["state"] == "FAILED"
        assert job["error_code"] == "NO_REPOSITORY"
        assert job["attempts"] == 1
        assert fake_github.commit_count() == 0

    def test_github_unavailable_retries_then_fails(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        _connect_and_configure(client, auth_headers)
        sid = client.post("/api/v1/submissions", json=make_body(), headers=auth_headers).json()[
            "submission"
        ]["id"]
        job_id = client.post(
            "/api/v1/sync", json={"submission_id": sid}, headers=auth_headers
        ).json()["job"]["id"]

        fake_github.contents_status = 500
        drain(app)
        job = client.get(f"/api/v1/sync/{job_id}", headers=auth_headers).json()
        assert job["state"] == "RETRY_PENDING"
        assert job["error_code"] == "GITHUB_UNAVAILABLE"
        assert job["attempts"] == 1

        # retries are scheduled in the future; force them due and drain until exhausted
        with app.state.db.session() as session:
            from app.models import SyncJob

            session.get(SyncJob, job_id).next_attempt_at = None
        for _ in range(6):
            drain(app)
            with app.state.db.session() as session:
                from app.models import SyncJob

                job_row = session.get(SyncJob, job_id)
                if job_row.state in ("FAILED", "SYNCED"):
                    break
                job_row.next_attempt_at = None

        job = client.get(f"/api/v1/sync/{job_id}", headers=auth_headers).json()
        assert job["state"] == "FAILED"
        assert job["attempts"] == 5
        assert (
            len(client.get(f"/api/v1/sync/{job_id}", headers=auth_headers).json()["attempts_log"])
            == 5
        )

        # once GitHub recovers, an explicit retry succeeds
        fake_github.contents_status = None
        retry = client.post(f"/api/v1/sync/{job_id}/retry", headers=auth_headers)
        assert retry.status_code == 200
        drain(app)
        assert (
            client.get(f"/api/v1/sync/{job_id}", headers=auth_headers).json()["state"] == "SYNCED"
        )

    def test_hand_written_file_conflict_is_permanent(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        _connect_and_configure(client, auth_headers)
        fake_github.put_file(
            "octo/dsa", "DSA-Solutions/LeetCode/0001-two-sum.py", "main", b"# my own notes\n"
        )
        client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)
        drain(app)
        job = client.get("/api/v1/sync", headers=auth_headers).json()["items"][0]
        assert job["state"] == "FAILED"
        assert job["error_code"] == "CONFLICT"
        # user content untouched
        assert b"my own notes" in fake_github.get_file(
            "octo/dsa", "DSA-Solutions/LeetCode/0001-two-sum.py", "main"
        )

    def test_rate_limited_by_github_schedules_retry(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        _connect_and_configure(client, auth_headers)
        client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)

        handler = fake_github.handler

        def rate_limited(request):
            if "/contents/" in request.url.path:
                return httpx.Response(
                    403,
                    json={"message": "API rate limit exceeded"},
                    headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "9999999999"},
                )
            return handler(request)

        app.state.sync_scheduler.worker.github_factory = _factory_with(
            httpx.MockTransport(rate_limited), app.state.settings
        )
        drain(app)
        job = client.get("/api/v1/sync", headers=auth_headers).json()["items"][0]
        assert job["state"] == "RETRY_PENDING"
        assert job["error_code"] == "RATE_LIMITED"

    def test_missing_github_connection_fails(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        client.patch("/api/v1/settings", json={"repo_full_name": "octo/dsa"}, headers=auth_headers)
        with app.state.db.session() as session:
            from sqlalchemy import select

            from app.models import OAuthConnection

            conn = session.execute(select(OAuthConnection)).scalars().first()
            conn.revoked_at = conn.created_at
        client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)
        drain(app)
        job = client.get("/api/v1/sync", headers=auth_headers).json()["items"][0]
        assert job["state"] == "FAILED"
        assert job["error_code"] == "AUTH_MISSING"

    def test_non_accepted_verdict_never_syncs(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        _connect_and_configure(client, auth_headers)
        client.post("/api/v1/submissions", json=make_body(verdict="rejected"), headers=auth_headers)
        assert drain(app) == 0
        assert client.get("/api/v1/sync", headers=auth_headers).json()["meta"]["total"] == 0


def _factory_with(transport, settings):
    from app.services.github import GitHubClient

    def factory(token: str) -> GitHubClient:
        return GitHubClient(
            token=token,
            base_url=settings.github_api_base_url,
            timeout=settings.github_timeout_seconds,
            transport=transport,
        )

    return factory

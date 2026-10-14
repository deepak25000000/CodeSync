"""API tests: settings, platforms, repositories, stats, account deletion, health of state."""

from __future__ import annotations

from fastapi.testclient import TestClient


class TestSettings:
    def test_defaults(self, client: TestClient, auth_headers: dict):
        body = client.get("/api/v1/settings", headers=auth_headers).json()
        assert body == {
            "repo_full_name": None,
            "branch": "main",
            "root_folder": "DSA-Solutions",
            "auto_sync": True,
            "github_connected": True,
            "platforms": {
                "leetcode": True,
                "geeksforgeeks": True,
                "codechef": True,
                "neetcode": True,
            },
        }

    def test_patch_partial(self, client: TestClient, auth_headers: dict):
        resp = client.patch(
            "/api/v1/settings",
            json={"repo_full_name": "octo/dsa", "branch": "dev", "root_folder": "Solutions"},
            headers=auth_headers,
        )
        assert resp.status_code == 200
        body = resp.json()
        assert body["repo_full_name"] == "octo/dsa"
        assert body["branch"] == "dev"
        assert body["root_folder"] == "Solutions"
        assert body["auto_sync"] is True  # untouched

    def test_clear_repo_with_empty_string(self, client: TestClient, auth_headers: dict):
        client.patch("/api/v1/settings", json={"repo_full_name": "octo/dsa"}, headers=auth_headers)
        body = client.patch(
            "/api/v1/settings", json={"repo_full_name": ""}, headers=auth_headers
        ).json()
        assert body["repo_full_name"] is None

    def test_rejects_bad_repo_name(self, client: TestClient, auth_headers: dict):
        resp = client.patch(
            "/api/v1/settings", json={"repo_full_name": "not a repo"}, headers=auth_headers
        )
        assert resp.status_code == 422

    def test_rejects_traversal_root_folder(self, client: TestClient, auth_headers: dict):
        resp = client.patch(
            "/api/v1/settings", json={"root_folder": "../evil"}, headers=auth_headers
        )
        assert resp.status_code == 422

    def test_rejects_bad_branch(self, client: TestClient, auth_headers: dict):
        resp = client.patch(
            "/api/v1/settings", json={"branch": "feature/../main"}, headers=auth_headers
        )
        assert resp.status_code == 422

    def test_requires_auth(self, client: TestClient):
        assert client.get("/api/v1/settings").status_code == 401


class TestPlatforms:
    def test_list_with_capabilities(self, client: TestClient, auth_headers: dict):
        rows = client.get("/api/v1/platforms", headers=auth_headers).json()["platforms"]
        assert len(rows) == 4
        leetcode = next(r for r in rows if r["id"] == "leetcode")
        assert leetcode["capabilities"]["submission_detection"] is True
        neetcode = next(r for r in rows if r["id"] == "neetcode")
        assert neetcode["capabilities"]["submission_detection"] is False

    def test_toggle_roundtrip(self, client: TestClient, auth_headers: dict):
        resp = client.put(
            "/api/v1/platforms/codechef", json={"enabled": False}, headers=auth_headers
        )
        assert resp.status_code == 200
        assert (
            next(r for r in resp.json()["platforms"] if r["id"] == "codechef")["enabled"] is False
        )
        # toggle persisted in settings too
        assert (
            client.get("/api/v1/settings", headers=auth_headers).json()["platforms"]["codechef"]
            is False
        )
        resp = client.put(
            "/api/v1/platforms/codechef", json={"enabled": True}, headers=auth_headers
        )
        assert next(r for r in resp.json()["platforms"] if r["id"] == "codechef")["enabled"] is True

    def test_unknown_platform_404(self, client: TestClient, auth_headers: dict):
        resp = client.put(
            "/api/v1/platforms/hackerrank", json={"enabled": True}, headers=auth_headers
        )
        assert resp.status_code == 404


class TestRepos:
    def test_list(self, client: TestClient, auth_headers: dict):
        body = client.get("/api/v1/repos", headers=auth_headers).json()
        assert body["items"][0]["full_name"] == "octo/dsa"
        assert body["items"][0]["permissions"]["push"] is True

    def test_create(self, client: TestClient, auth_headers: dict):
        resp = client.post(
            "/api/v1/repos",
            json={"name": "solutions", "description": "mine", "private": True},
            headers=auth_headers,
        )
        assert resp.status_code == 201
        assert resp.json()["full_name"] == "octo/solutions"

    def test_requires_github_connection(self, client: TestClient, token: str):
        # revoke the GitHub credential, keep the API token
        with client.app.state.db.session() as session:
            from sqlalchemy import select

            from app.models import OAuthConnection

            row = session.execute(select(OAuthConnection)).scalars().first()
            assert row is not None
            row.revoked_at = row.created_at
        headers = {"Authorization": f"Bearer {token}"}
        resp = client.get("/api/v1/repos", headers=headers)
        assert resp.status_code == 400
        assert resp.json()["detail"]["code"] == "AUTH_MISSING"


class TestGithubConnectionCheck:
    def test_connected(self, client: TestClient, auth_headers: dict):
        body = client.get("/api/v1/github/connection", headers=auth_headers).json()
        assert body == {"connected": True, "github_login": "octo"}

    def test_disconnected(self, client: TestClient, token: str):
        with client.app.state.db.session() as session:
            from sqlalchemy import select

            from app.models import OAuthConnection

            row = session.execute(select(OAuthConnection)).scalars().first()
            row.revoked_at = row.created_at
        resp = client.get("/api/v1/github/connection", headers={"Authorization": f"Bearer {token}"})
        assert resp.json()["connected"] is False


class TestStats:
    def test_counts(self, client: TestClient, auth_headers: dict, app, fake_github):
        from tests.conftest import drain
        from tests.test_api_submissions import make_body

        client.patch("/api/v1/settings", json={"repo_full_name": "octo/dsa"}, headers=auth_headers)
        client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)
        client.post(
            "/api/v1/submissions",
            json=make_body(external_id="9", verdict="rejected", problem_id="9", title="Nope"),
            headers=auth_headers,
        )
        drain(app)

        body = client.get("/api/v1/stats", headers=auth_headers).json()
        assert body["submissions_total"] == 2
        assert body["accepted_total"] == 1
        assert body["jobs_by_state"]["SYNCED"] == 1
        assert body["submissions_by_platform"]["leetcode"] == 2
        assert body["synced_by_platform"]["leetcode"] == 1


class TestAccountDeletion:
    def test_delete_wipes_everything(self, client: TestClient, auth_headers: dict, app):
        from tests.test_api_submissions import make_body

        client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)
        assert client.request("DELETE", "/api/v1/account", headers=auth_headers).status_code == 200
        # token no longer valid
        assert client.get("/api/v1/auth/me", headers=auth_headers).status_code == 401
        with app.state.db.session() as session:
            from app.models import Submission, SyncJob, User

            assert session.query(User).count() == 0
            assert session.query(Submission).count() == 0
            assert session.query(SyncJob).count() == 0

    def test_requires_auth(self, client: TestClient):
        assert client.request("DELETE", "/api/v1/account").status_code == 401

"""API tests: sync job creation, duplicate handling, retry, listing, details."""

from __future__ import annotations

from fastapi.testclient import TestClient

from tests.test_api_submissions import make_body


def _submission(client: TestClient, headers: dict, **kw) -> int:
    resp = client.post("/api/v1/submissions", json=make_body(**kw), headers=headers)
    assert resp.status_code == 201, resp.text
    return resp.json()["submission"]["id"]


class TestCreateSync:
    def test_sync_accepted_submission(self, client: TestClient, auth_headers: dict):
        sid = _submission(client, auth_headers)
        # auto_sync already queued a job -> explicit create returns duplicate
        resp = client.post("/api/v1/sync", json={"submission_id": sid}, headers=auth_headers)
        assert resp.status_code == 200
        body = resp.json()
        assert body["duplicate"] is True and body["job"]["state"] == "QUEUED"

    def test_sync_when_auto_sync_disabled(self, client: TestClient, auth_headers: dict):
        client.patch("/api/v1/settings", json={"auto_sync": False}, headers=auth_headers)
        sid = _submission(client, auth_headers)
        resp = client.post("/api/v1/sync", json={"submission_id": sid}, headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["duplicate"] is False
        assert resp.json()["job"]["state"] == "QUEUED"

    def test_rejected_submission_conflict(self, client: TestClient, auth_headers: dict):
        sid = _submission(client, auth_headers, verdict="rejected")
        resp = client.post("/api/v1/sync", json={"submission_id": sid}, headers=auth_headers)
        assert resp.status_code == 409
        assert resp.json()["detail"]["code"] == "INVALID_VERDICT"

    def test_unknown_submission_404(self, client: TestClient, auth_headers: dict):
        resp = client.post("/api/v1/sync", json={"submission_id": 424242}, headers=auth_headers)
        assert resp.status_code == 404

    def test_cross_user_404(self, client: TestClient):
        t1 = client.post("/api/v1/auth/pat", json={"token": "ghp_alice_token"}).json()["api_token"]
        t2 = client.post("/api/v1/auth/pat", json={"token": "ghp_bob_token"}).json()["api_token"]
        h1 = {"Authorization": f"Bearer {t1}"}
        sid = _submission(client, h1)
        resp = client.post(
            "/api/v1/sync",
            json={"submission_id": sid},
            headers={"Authorization": f"Bearer {t2}"},
        )
        assert resp.status_code == 404

    def test_requires_auth(self, client: TestClient):
        assert client.post("/api/v1/sync", json={"submission_id": 1}).status_code == 401


class TestRetry:
    def test_retry_failed_job(self, client: TestClient, auth_headers: dict, app):
        client.patch("/api/v1/settings", json={"auto_sync": False}, headers=auth_headers)
        sid = _submission(client, auth_headers)
        job_id = client.post(
            "/api/v1/sync", json={"submission_id": sid}, headers=auth_headers
        ).json()["job"]["id"]

        # force the job into FAILED
        with app.state.db.session() as session:
            from app.models import JobState, SyncJob

            job = session.get(SyncJob, job_id)
            job.state = JobState.failed.value
            job.attempts = 5

        resp = client.post(f"/api/v1/sync/{job_id}/retry", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["job"]["state"] == "QUEUED"

    def test_retry_synced_job_conflict(self, client: TestClient, auth_headers: dict, app):
        client.patch("/api/v1/settings", json={"auto_sync": False}, headers=auth_headers)
        sid = _submission(client, auth_headers)
        job_id = client.post(
            "/api/v1/sync", json={"submission_id": sid}, headers=auth_headers
        ).json()["job"]["id"]
        with app.state.db.session() as session:
            from app.models import JobState, SyncJob

            session.get(SyncJob, job_id).state = JobState.synced.value
        assert client.post(f"/api/v1/sync/{job_id}/retry", headers=auth_headers).status_code == 409

    def test_retry_missing_404(self, client: TestClient, auth_headers: dict):
        assert client.post("/api/v1/sync/9999/retry", headers=auth_headers).status_code == 404


class TestListAndDetail:
    def test_list_and_state_filter(self, client: TestClient, auth_headers: dict):
        for i in range(3):
            _submission(client, auth_headers, external_id=str(500 + i))
        all_jobs = client.get("/api/v1/sync", headers=auth_headers).json()
        assert all_jobs["meta"]["total"] == 3
        queued = client.get("/api/v1/sync", params={"state": "QUEUED"}, headers=auth_headers).json()
        assert queued["meta"]["total"] == 3
        failed = client.get("/api/v1/sync", params={"state": "FAILED"}, headers=auth_headers).json()
        assert failed["meta"]["total"] == 0

    def test_detail_includes_attempts_log(
        self, client: TestClient, auth_headers: dict, app, fake_github
    ):
        from tests.conftest import drain

        client.patch("/api/v1/settings", json={"repo_full_name": "octo/dsa"}, headers=auth_headers)
        sid = _submission(client, auth_headers)
        job_id = client.post(
            "/api/v1/sync", json={"submission_id": sid}, headers=auth_headers
        ).json()["job"]["id"]
        drain(app)

        detail = client.get(f"/api/v1/sync/{job_id}", headers=auth_headers).json()
        assert detail["state"] == "SYNCED"
        assert detail["commit_sha"]
        assert len(detail["attempts_log"]) == 1
        assert detail["attempts_log"][0]["state"] == "SYNCED"

    def test_detail_cross_user_404(self, client: TestClient):
        t1 = client.post("/api/v1/auth/pat", json={"token": "ghp_alice_token"}).json()["api_token"]
        t2 = client.post("/api/v1/auth/pat", json={"token": "ghp_bob_token"}).json()["api_token"]
        h1 = {"Authorization": f"Bearer {t1}"}
        _submission(client, h1)
        job_id = client.get("/api/v1/sync", headers=h1).json()["items"][0]["id"]
        assert (
            client.get(
                f"/api/v1/sync/{job_id}", headers={"Authorization": f"Bearer {t2}"}
            ).status_code
            == 404
        )

"""API tests: submission ingestion, idempotency, validation, listing, isolation."""

from __future__ import annotations

from fastapi.testclient import TestClient


def make_body(**kw) -> dict:
    body = {
        "platform": "leetcode",
        "title": "Two Sum",
        "language": "python",
        "code": "class Solution:\n    def twoSum(self, nums, target):\n        return []\n",
        "external_id": "1001",
        "problem_id": "1",
        "url": "https://leetcode.com/problems/two-sum/",
        "verdict": "accepted",
    }
    body.update(kw)
    return body


class TestCreateSubmission:
    def test_accepted_creates_validated_submission_and_job(
        self, client: TestClient, auth_headers: dict
    ):
        resp = client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)
        assert resp.status_code == 201
        body = resp.json()
        assert body["duplicate"] is False
        assert body["submission"]["status"] == "VALIDATED"
        assert body["submission"]["verdict"] == "accepted"
        assert body["sync_job_id"] is not None

    def test_replay_is_idempotent(self, client: TestClient, auth_headers: dict):
        first = client.post("/api/v1/submissions", json=make_body(), headers=auth_headers).json()
        second = client.post("/api/v1/submissions", json=make_body(), headers=auth_headers).json()
        assert second["duplicate"] is True
        assert second["submission"]["id"] == first["submission"]["id"]
        assert second["sync_job_id"] == first["sync_job_id"]
        assert client.get("/api/v1/submissions", headers=auth_headers).json()["meta"]["total"] == 1

    def test_same_id_different_content_still_dedupes_on_id(
        self, client: TestClient, auth_headers: dict
    ):
        a = client.post(
            "/api/v1/submissions", json=make_body(code="print(1)"), headers=auth_headers
        ).json()
        b = client.post(
            "/api/v1/submissions", json=make_body(code="print(2)"), headers=auth_headers
        ).json()
        assert b["duplicate"] is True and a["submission"]["id"] == b["submission"]["id"]

    def test_no_id_dedupes_on_content(self, client: TestClient, auth_headers: dict):
        client.post(
            "/api/v1/submissions", json=make_body(external_id=None, url=None), headers=auth_headers
        )
        client.post(
            "/api/v1/submissions", json=make_body(external_id=None, url=None), headers=auth_headers
        )
        assert client.get("/api/v1/submissions", headers=auth_headers).json()["meta"]["total"] == 1
        # different code without an id is a distinct submission
        client.post(
            "/api/v1/submissions",
            json=make_body(external_id=None, url=None, code="print(999)"),
            headers=auth_headers,
        )
        assert client.get("/api/v1/submissions", headers=auth_headers).json()["meta"]["total"] == 2

    def test_rejected_verdict_not_queued(self, client: TestClient, auth_headers: dict):
        body = client.post(
            "/api/v1/submissions", json=make_body(verdict="rejected"), headers=auth_headers
        ).json()
        assert body["submission"]["status"] == "REJECTED"
        assert body["sync_job_id"] is None

    def test_pending_verdict_stays_detected(self, client: TestClient, auth_headers: dict):
        body = client.post(
            "/api/v1/submissions", json=make_body(verdict="pending"), headers=auth_headers
        ).json()
        assert body["submission"]["status"] == "DETECTED"
        assert body["sync_job_id"] is None

    def test_unknown_verdict_unsupported(self, client: TestClient, auth_headers: dict):
        body = client.post(
            "/api/v1/submissions", json=make_body(verdict="unknown"), headers=auth_headers
        ).json()
        assert body["submission"]["status"] == "UNSUPPORTED"
        assert body["sync_job_id"] is None

    def test_manual_verdict_validated_and_queued(self, client: TestClient, auth_headers: dict):
        body = client.post(
            "/api/v1/submissions",
            json=make_body(platform="neetcode", verdict="manual"),
            headers=auth_headers,
        ).json()
        assert body["submission"]["status"] == "VALIDATED"
        assert body["sync_job_id"] is not None

    def test_auto_sync_off_suppresses_job(self, client: TestClient, auth_headers: dict):
        client.patch("/api/v1/settings", json={"auto_sync": False}, headers=auth_headers)
        body = client.post("/api/v1/submissions", json=make_body(), headers=auth_headers).json()
        assert body["sync_job_id"] is None

    def test_body_auto_sync_overrides_setting(self, client: TestClient, auth_headers: dict):
        client.patch("/api/v1/settings", json={"auto_sync": False}, headers=auth_headers)
        body = client.post(
            "/api/v1/submissions", json=make_body(auto_sync=True), headers=auth_headers
        ).json()
        assert body["sync_job_id"] is not None

    def test_disabled_platform_forbidden(self, client: TestClient, auth_headers: dict):
        client.put("/api/v1/platforms/leetcode", json={"enabled": False}, headers=auth_headers)
        resp = client.post("/api/v1/submissions", json=make_body(), headers=auth_headers)
        assert resp.status_code == 403
        assert resp.json()["detail"]["code"] == "PLATFORM_DISABLED"
        client.put("/api/v1/platforms/leetcode", json={"enabled": True}, headers=auth_headers)

    def test_requires_auth(self, client: TestClient):
        assert client.post("/api/v1/submissions", json=make_body()).status_code == 401

    def test_validation_bad_url(self, client: TestClient, auth_headers: dict):
        resp = client.post(
            "/api/v1/submissions", json=make_body(url="javascript:alert(1)"), headers=auth_headers
        )
        assert resp.status_code == 422

    def test_validation_missing_fields(self, client: TestClient, auth_headers: dict):
        resp = client.post(
            "/api/v1/submissions", json={"platform": "leetcode"}, headers=auth_headers
        )
        assert resp.status_code == 422


class TestListSubmissions:
    def _seed(self, client: TestClient, headers: dict, n: int = 5):
        for i in range(n):
            client.post(
                "/api/v1/submissions",
                json=make_body(external_id=str(1000 + i), title=f"Problem {i}"),
                headers=headers,
            )

    def test_pagination_meta(self, client: TestClient, auth_headers: dict):
        self._seed(client, auth_headers, 5)
        page = client.get(
            "/api/v1/submissions", params={"page": 2, "per_page": 2}, headers=auth_headers
        ).json()
        assert page["meta"] == {"page": 2, "per_page": 2, "total": 5}
        assert len(page["items"]) == 2

    def test_platform_filter(self, client: TestClient, auth_headers: dict):
        self._seed(client, auth_headers, 3)
        client.post(
            "/api/v1/submissions",
            json=make_body(platform="codechef", external_id="cc1"),
            headers=auth_headers,
        )
        assert (
            client.get(
                "/api/v1/submissions", params={"platform": "codechef"}, headers=auth_headers
            ).json()["meta"]["total"]
            == 1
        )

    def test_verdict_filter(self, client: TestClient, auth_headers: dict):
        client.post("/api/v1/submissions", json=make_body(verdict="rejected"), headers=auth_headers)
        assert (
            client.get(
                "/api/v1/submissions", params={"verdict": "rejected"}, headers=auth_headers
            ).json()["meta"]["total"]
            == 1
        )

    def test_get_single_and_cross_user_isolation(self, client: TestClient):
        t1 = client.post("/api/v1/auth/pat", json={"token": "ghp_alice_token"}).json()["api_token"]
        t2 = client.post("/api/v1/auth/pat", json={"token": "ghp_bob_token"}).json()["api_token"]
        h1 = {"Authorization": f"Bearer {t1}"}
        h2 = {"Authorization": f"Bearer {t2}"}
        sid = client.post("/api/v1/submissions", json=make_body(), headers=h1).json()["submission"][
            "id"
        ]

        assert client.get(f"/api/v1/submissions/{sid}", headers=h1).status_code == 200
        assert client.get(f"/api/v1/submissions/{sid}", headers=h2).status_code == 404
        assert client.get("/api/v1/submissions", headers=h2).json()["meta"]["total"] == 0

    def test_missing_404(self, client: TestClient, auth_headers: dict):
        assert client.get("/api/v1/submissions/99999", headers=auth_headers).status_code == 404

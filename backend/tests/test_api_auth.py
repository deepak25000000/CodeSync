"""API tests: health, portal, auth flows (PAT, OAuth, tokens), rate limiting."""

from __future__ import annotations

import httpx
from fastapi.testclient import TestClient

from tests.conftest import FakeGitHub, make_settings


def test_health(client: TestClient):
    resp = client.get("/api/v1/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok" and body["app"] == "CodeSync" and body["environment"] == "test"


def test_meta_lists_all_platforms(client: TestClient):
    body = client.get("/api/v1/meta").json()
    assert {p["id"] for p in body["platforms"]} == {
        "leetcode",
        "geeksforgeeks",
        "codechef",
        "neetcode",
    }
    assert body["oauth_enabled"] is False


def test_portal_page_renders(client: TestClient):
    resp = client.get("/")
    assert resp.status_code == 200
    assert "CodeSync" in resp.text and "personal access token" in resp.text


def test_docs_available(client: TestClient):
    assert client.get("/docs").status_code == 200
    assert client.get("/openapi.json").status_code == 200


def test_request_id_header_echoed(client: TestClient):
    resp = client.get("/api/v1/health", headers={"X-Request-Id": "abc123"})
    assert resp.headers["X-Request-Id"] == "abc123"
    assert resp.headers["X-Content-Type-Options"] == "nosniff"


class TestPatFlow:
    def test_connect_issues_token(self, client: TestClient):
        resp = client.post("/api/v1/auth/pat", json={"token": "ghp_test_token"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["api_token"].startswith("cs_")
        assert body["github_login"] == "octo"
        assert body["user"]["id"] >= 1

    def test_invalid_pat_rejected(self, client: TestClient):
        resp = client.post("/api/v1/auth/pat", json={"token": "ghp_bad_token"})
        assert resp.status_code == 401
        assert resp.json()["detail"]["code"] == "GITHUB_REJECTED"

    def test_short_token_validation_error(self, client: TestClient):
        resp = client.post("/api/v1/auth/pat", json={"token": "short"})
        assert resp.status_code == 422

    def test_me_requires_token(self, client: TestClient):
        assert client.get("/api/v1/auth/me").status_code == 401
        assert (
            client.get("/api/v1/auth/me", headers={"Authorization": "Bearer nope"}).status_code
            == 401
        )

    def test_me_returns_flat_contract(self, client: TestClient, auth_headers: dict):
        body = client.get("/api/v1/auth/me", headers=auth_headers).json()
        assert body["github_login"] == "octo"
        assert body["github_connected"] is True
        assert body["settings"]["auto_sync"] is True
        assert body["settings"]["repo_full_name"] is None
        assert len(body["platforms"]) == 4

    def test_persisted_token_survives_new_session(self, client: TestClient):
        token = client.post("/api/v1/auth/pat", json={"token": "ghp_alice_token"}).json()[
            "api_token"
        ]
        resp = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
        assert resp.status_code == 200
        assert resp.json()["github_login"] == "alice"


class TestOAuthFlow:
    def _app_with_oauth(self, tmp_path, fake_github: FakeGitHub):
        from app.main import create_app

        settings = make_settings(tmp_path, github_client_id="cid", github_client_secret="csec")
        return create_app(settings, transport=httpx.MockTransport(fake_github.handler))

    def test_start_redirects_to_github(self, tmp_path, fake_github):
        app = self._app_with_oauth(tmp_path, fake_github)
        with TestClient(app, follow_redirects=False) as client:
            resp = client.get("/api/v1/auth/github/start")
            assert resp.status_code == 302
            location = resp.headers["location"]
            assert location.startswith("https://github.com/login/oauth/authorize")
            assert "client_id=cid" in location and "state=" in location
            assert client.cookies.get("codesync_oauth_state")

    def test_start_unavailable_without_credentials(self, client: TestClient):
        resp = client.get("/api/v1/auth/github/start")
        assert resp.status_code == 501
        assert resp.json()["detail"]["code"] == "OAUTH_NOT_CONFIGURED"

    def test_callback_happy_path_issues_token(self, tmp_path, fake_github):
        app = self._app_with_oauth(tmp_path, fake_github)
        with TestClient(app, follow_redirects=False) as client:
            start = client.get("/api/v1/auth/github/start")
            state = start.headers["location"].split("state=")[1].split("&")[0]
            resp = client.get(
                "/api/v1/auth/github/callback", params={"code": "good", "state": state}
            )
            assert resp.status_code == 200
            assert "cs_" in resp.text and "Connected as" in resp.text

    def test_callback_rejects_forged_state(self, tmp_path, fake_github):
        app = self._app_with_oauth(tmp_path, fake_github)
        with TestClient(app, follow_redirects=False) as client:
            resp = client.get(
                "/api/v1/auth/github/callback", params={"code": "good", "state": "forged"}
            )
            assert resp.status_code == 400
            assert "state" in resp.text.lower()

    def test_callback_surfaces_provider_error(self, tmp_path, fake_github):
        app = self._app_with_oauth(tmp_path, fake_github)
        with TestClient(app, follow_redirects=False) as client:
            resp = client.get("/api/v1/auth/github/callback", params={"error": "access_denied"})
            assert resp.status_code == 400

    # --- one-click extension sign-in (chrome.identity redirect) ---------------

    EXT_REDIRECT = "https://" + "a" * 32 + ".chromiumapp.org/"

    def test_extension_start_rejects_foreign_redirect_uri(self, tmp_path, fake_github):
        app = self._app_with_oauth(tmp_path, fake_github)
        with TestClient(app, follow_redirects=False) as client:
            resp = client.get(
                "/api/v1/auth/github/start",
                params={"client": "extension", "redirect_uri": "https://evil.example/"},
            )
            assert resp.status_code == 400
            assert resp.json()["detail"]["code"] == "INVALID_REDIRECT_URI"

    def test_extension_callback_redirects_token_to_chromiumapp(self, tmp_path, fake_github):
        app = self._app_with_oauth(tmp_path, fake_github)
        with TestClient(app, follow_redirects=False) as client:
            start = client.get(
                "/api/v1/auth/github/start",
                params={"client": "extension", "redirect_uri": self.EXT_REDIRECT},
            )
            assert start.status_code == 302
            state = start.headers["location"].split("state=")[1].split("&")[0]
            resp = client.get(
                "/api/v1/auth/github/callback", params={"code": "good", "state": state}
            )
            assert resp.status_code == 302
            location = resp.headers["location"]
            assert location.startswith(self.EXT_REDIRECT)
            assert "token=cs_" in location

    def test_extension_redirect_never_leaks_token_on_forged_cookie(self, tmp_path, fake_github):
        from app.api.auth import _encode_ext_cookie

        app = self._app_with_oauth(tmp_path, fake_github)
        with TestClient(app, follow_redirects=False) as client:
            client.cookies.set(
                "codesync_oauth_ext",
                _encode_ext_cookie("https://evil.example/"),
                domain="testserver",
            )
            start = client.get("/api/v1/auth/github/start")
            state = start.headers["location"].split("state=")[1].split("&")[0]
            resp = client.get(
                "/api/v1/auth/github/callback", params={"code": "good", "state": state}
            )
            # Tampered/foreign redirect falls back to the portal page — the
            # token is never redirected anywhere unvalidated.
            assert resp.status_code == 200
            assert "cs_" in resp.text

    def test_ext_cookie_decoding_is_strict(self):
        from app.api.auth import _decode_ext_cookie, _encode_ext_cookie

        assert _decode_ext_cookie(None) is None
        assert _decode_ext_cookie("") is None
        assert _decode_ext_cookie("not-base64!!") is None
        assert _decode_ext_cookie(_encode_ext_cookie("https://evil.example/")) is None
        uri = "https://" + "b" * 32 + ".chromiumapp.org/"
        assert _decode_ext_cookie(_encode_ext_cookie(uri)) == uri


class TestTokenManagement:
    def test_mint_rotate(self, client: TestClient, auth_headers: dict):
        resp = client.post("/api/v1/auth/token", headers=auth_headers)
        assert resp.status_code == 200
        assert resp.json()["api_token"].startswith("cs_")

    def test_list_and_revoke(self, client: TestClient, auth_headers: dict):
        items = client.get("/api/v1/auth/tokens", headers=auth_headers).json()["items"]
        assert len(items) == 1
        assert "hash" not in str(items)
        token_id = items[0]["id"]
        assert (
            client.delete(f"/api/v1/auth/tokens/{token_id}", headers=auth_headers).status_code
            == 200
        )
        # original token now dead
        assert client.get("/api/v1/auth/me", headers=auth_headers).status_code == 401

    def test_revoke_other_users_token_404(self, client: TestClient):
        t1 = client.post("/api/v1/auth/pat", json={"token": "ghp_alice_token"}).json()["api_token"]
        t2 = client.post("/api/v1/auth/pat", json={"token": "ghp_bob_token"}).json()["api_token"]
        h1 = {"Authorization": f"Bearer {t1}"}
        other_id = client.get(
            "/api/v1/auth/tokens", headers={"Authorization": f"Bearer {t2}"}
        ).json()["items"][0]["id"]
        assert client.delete(f"/api/v1/auth/tokens/{other_id}", headers=h1).status_code == 404


def test_rate_limit_returns_429(tmp_path, fake_github: FakeGitHub):
    from app.main import create_app

    settings = make_settings(
        tmp_path, rate_limit_enabled=True, rate_limit_requests=3, rate_limit_window_seconds=60
    )
    app = create_app(settings, transport=httpx.MockTransport(fake_github.handler))
    with TestClient(app, follow_redirects=False) as client:
        token = client.post("/api/v1/auth/pat", json={"token": "ghp_test_token"}).json()[
            "api_token"
        ]
        headers = {"Authorization": f"Bearer {token}"}
        statuses = [client.get("/api/v1/auth/me", headers=headers).status_code for _ in range(5)]
        assert statuses[:3] == [200, 200, 200]
        assert 429 in statuses[3:]


def test_payload_too_large_rejected(tmp_path, fake_github: FakeGitHub):
    from app.main import create_app

    settings = make_settings(tmp_path, max_request_bytes=1000)
    app = create_app(settings, transport=httpx.MockTransport(fake_github.handler))
    with TestClient(app, follow_redirects=False) as client:
        resp = client.post(
            "/api/v1/auth/pat",
            content=b'{"token": "' + b"x" * 2000 + b'"}',
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 413
        assert resp.json()["detail"]["code"] == "PAYLOAD_TOO_LARGE"

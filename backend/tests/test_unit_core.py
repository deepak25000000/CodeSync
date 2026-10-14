"""Unit tests: fingerprinting, backoff, error classification, security, rate limit, matrix."""

from __future__ import annotations

import time

import httpx
import pytest

from app.platforms import PLATFORMS, platform_matrix
from app.ratelimit import SlidingWindowRateLimiter
from app.security import (
    CredentialCipher,
    generate_api_token,
    generate_state,
    hash_api_token,
    redact,
)
from app.services.backoff import compute_backoff, should_retry
from app.services.errors import classify_github_status, classify_network_error
from app.services.fingerprint import (
    content_hash,
    find_marker,
    fingerprint_marker,
    normalize_code,
    stable_fingerprint,
)


class TestFingerprint:
    def test_same_submission_id_is_stable(self):
        a = stable_fingerprint("leetcode", "12345", "https://x", "python", "print(1)")
        b = stable_fingerprint("leetcode", "12345", "https://other", "c++", "totally different")
        assert a == b  # id basis wins over everything else

    def test_content_basis_when_no_id(self):
        a = stable_fingerprint(
            "leetcode", None, "https://leetcode.com/problems/two-sum/", "Python", "x=1"
        )
        b = stable_fingerprint(
            "leetcode", None, "https://leetcode.com/problems/two-sum/", "python", "x=1  "
        )
        assert a == b  # url/language normalized, trailing ws insignificant

    def test_different_content_differs(self):
        a = stable_fingerprint("leetcode", None, "https://x", "python", "x=1")
        b = stable_fingerprint("leetcode", None, "https://x", "python", "x=2")
        assert a != b

    def test_normalized_code_strips_crlf_and_trailing_ws(self):
        assert normalize_code("a  \r\nb\r\n") == "a\nb"
        assert content_hash("a\nb") == content_hash("a  \r\nb\r\n")

    def test_marker_roundtrip(self):
        fp = stable_fingerprint("codechef", "9", "https://x", "cpp", "int main(){}")
        text = f"{fingerprint_marker(fp)}\nint main(){{}}"
        assert find_marker(text) == fp
        assert find_marker("no marker here") is None

    def test_fingerprint_hex_64(self):
        fp = stable_fingerprint("geeksforgeeks", None, None, "java", None)
        assert len(fp) == 64 and all(c in "0123456789abcdef" for c in fp)


class TestBackoff:
    def test_monotonic_and_capped(self):
        delays = [compute_backoff(i, jitter=False) for i in range(1, 12)]
        assert delays == sorted(delays)
        assert delays[-1] <= 300

    def test_jitter_within_bounds(self):
        import random

        rng = random.Random(7)
        for attempt in range(1, 8):
            raw = min(300.0, 2.0 * (2 ** (attempt - 1)))
            for _ in range(20):
                d = compute_backoff(attempt, rng=rng)
                assert raw / 2 - 1e-9 <= d <= raw + 1e-9

    def test_deterministic_without_jitter(self):
        assert compute_backoff(1, jitter=False) == 2.0
        assert compute_backoff(3, jitter=False) == 8.0

    def test_should_retry_boundaries(self):
        assert should_retry(1, 5) is True
        assert should_retry(5, 5) is False
        assert should_retry(6, 5) is False


class TestErrorClassification:
    @pytest.mark.parametrize(
        "status,expected,retryable",
        [
            (401, "AUTH_EXPIRED", False),
            (404, "NOT_FOUND", False),
            (409, "CONFLICT", True),
            (422, "VALIDATION", False),
            (500, "GITHUB_UNAVAILABLE", True),
            (502, "GITHUB_UNAVAILABLE", True),
        ],
    )
    def test_status_matrix(self, status, expected, retryable):
        err = classify_github_status(status, {"message": "boom"})
        assert err.code == expected and err.retryable is retryable

    def test_rate_limit_403(self):
        err = classify_github_status(
            403, {"message": "API rate limit exceeded"}, {"x-ratelimit-remaining": "0"}
        )
        assert err.code == "RATE_LIMITED" and err.retryable is True

    def test_forbidden_403_is_permanent(self):
        err = classify_github_status(403, {"message": "Resource not accessible"})
        assert err.code == "PERMISSION_DENIED" and err.retryable is False

    def test_429_uses_retry_after(self):
        err = classify_github_status(429, "slow down", {"retry-after": "12"})
        assert err.code == "RATE_LIMITED" and err.retry_after == 12.0

    def test_network_errors_retryable(self):
        assert classify_network_error(httpx.ConnectError("nope")).retryable is True
        assert classify_network_error(httpx.ReadTimeout("slow")).code == "TIMEOUT"
        assert classify_network_error(ValueError("?")).retryable is True


class TestSecurity:
    def test_token_roundtrip(self):
        plaintext, digest = generate_api_token()
        assert plaintext.startswith("cs_")
        assert digest == hash_api_token(plaintext)
        assert len(digest) == 64
        assert hash_api_token(plaintext + "x") != digest

    def test_state_values_unique(self):
        s1, h1 = generate_state()
        s2, h2 = generate_state()
        assert s1 != s2 and h1 != h2

    def test_cipher_roundtrip(self):
        cipher = CredentialCipher("my-secret")
        token = "ghp_super_secret_token"
        encrypted = cipher.encrypt(token)
        assert token not in encrypted
        assert cipher.decrypt(encrypted) == token

    def test_cipher_wrong_key_fails(self):
        encrypted = CredentialCipher("key-a").encrypt("ghp_x")
        with pytest.raises(RuntimeError):
            CredentialCipher("key-b").decrypt(encrypted)

    def test_cipher_unconfigured(self):
        assert CredentialCipher("").configured is False
        with pytest.raises(RuntimeError):
            CredentialCipher("").encrypt("x")

    def test_redaction(self):
        payload = {
            "token": "cs_secret",
            "Authorization": "Bearer abc",
            "nested": {"access_token": "ghp_x", "login": "alice"},
            "items": [{"password": "p"}],
        }
        clean = redact(payload)
        assert clean["token"] == "<redacted>"
        assert clean["nested"]["access_token"] == "<redacted>"
        assert clean["items"][0]["password"] == "<redacted>"
        assert clean["nested"]["login"] == "alice"
        assert redact("Bearer xyz") == "Bearer <redacted>"


class TestRateLimiter:
    def test_allows_then_blocks(self):
        limiter = SlidingWindowRateLimiter(3, 60)
        assert [limiter.check("k")[0] for _ in range(3)] == [True, True, True]
        allowed, remaining, retry_after = limiter.check("k")
        assert allowed is False and remaining == 0 and 0 < retry_after <= 60

    def test_window_slides(self):
        limiter = SlidingWindowRateLimiter(2, 1)
        limiter.check("k")
        time.sleep(1.1)
        assert limiter.check("k")[0] is True

    def test_keys_are_isolated(self):
        limiter = SlidingWindowRateLimiter(1, 60)
        assert limiter.check("a")[0] is True
        assert limiter.check("b")[0] is True
        assert limiter.check("a")[0] is False

    def test_reset(self):
        limiter = SlidingWindowRateLimiter(1, 60)
        limiter.check("k")
        limiter.reset()
        assert limiter.check("k")[0] is True


class TestPlatformMatrix:
    def test_all_four_platforms(self):
        assert set(PLATFORMS) == {"leetcode", "geeksforgeeks", "codechef", "neetcode"}
        rows = platform_matrix()
        assert {r["id"] for r in rows} == set(PLATFORMS)

    def test_enabled_flag(self):
        rows = platform_matrix({"leetcode": False})
        by_id = {r["id"]: r for r in rows}
        assert by_id["leetcode"]["enabled"] is False
        assert by_id["codechef"]["enabled"] is True

    def test_neetcode_is_capability_limited(self):
        caps = platform_matrix()[3]["capabilities"]
        assert caps["submission_detection"] is False
        assert caps["verdict_extraction"] is False
        assert caps["solution_code_extraction"] is False
        assert caps["problem_metadata"] is True

    def test_judging_platforms_have_full_capability(self):
        for row in platform_matrix():
            if row["id"] == "neetcode":
                continue
            caps = row["capabilities"]
            assert caps["submission_detection"] and caps["verdict_extraction"]
            assert caps["solution_code_extraction"] and caps["problem_metadata"]

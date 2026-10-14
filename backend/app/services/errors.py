"""Error classification for sync failures (retryable vs permanent)."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ClassifiedError(Exception):
    code: str
    message: str
    retryable: bool
    http_status: int | None = None
    retry_after: float | None = None

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.code}: {self.message}"


class SyncError(ClassifiedError):
    pass


def classify_github_status(
    status: int, body: dict | str | None, headers: dict | str | None = None
) -> ClassifiedError:
    hdrs: dict = headers if isinstance(headers, dict) else {}
    message = _extract_message(body)

    if status == 401:
        return SyncError(
            "AUTH_EXPIRED", "GitHub authorization expired; reconnect GitHub.", False, status
        )
    if status == 403:
        remaining = hdrs.get("x-ratelimit-remaining")
        if remaining == "0" or "rate limit" in message.lower():
            reset = hdrs.get("x-ratelimit-reset")
            retry_after = None
            try:
                if reset:
                    import time

                    retry_after = max(0.0, float(reset) - time.time())
                else:
                    retry_after_header = hdrs.get("retry-after")
                    if retry_after_header:
                        retry_after = float(retry_after_header)
            except (TypeError, ValueError):
                retry_after = None
            return SyncError(
                "RATE_LIMITED",
                "GitHub rate limit reached; will retry later.",
                True,
                status,
                retry_after,
            )
        return SyncError(
            "PERMISSION_DENIED",
            f"Repository permission denied or forbidden: {message}",
            False,
            status,
        )
    if status == 404:
        return SyncError("NOT_FOUND", f"Repository or path not found: {message}", False, status)
    if status == 409:
        return SyncError("CONFLICT", f"Concurrent update conflict: {message}", True, status)
    if status == 422:
        return SyncError("VALIDATION", f"GitHub rejected the request: {message}", False, status)
    if status == 429:
        retry_after = None
        try:
            retry_after_header = hdrs.get("retry-after")
            if retry_after_header:
                retry_after = float(retry_after_header)
        except (TypeError, ValueError):
            retry_after = None
        return SyncError(
            "RATE_LIMITED", "Too many requests; will retry later.", True, status, retry_after
        )
    if status >= 500:
        return SyncError(
            "GITHUB_UNAVAILABLE", f"GitHub server error ({status}): {message}", True, status
        )
    return SyncError("GITHUB_ERROR", f"GitHub error ({status}): {message}", status >= 500, status)


def classify_network_error(exc: BaseException) -> ClassifiedError:
    import httpx

    if isinstance(exc, httpx.TimeoutException):
        return SyncError("TIMEOUT", f"Request timed out: {exc}", True, None)
    if isinstance(
        exc,
        (
            httpx.ConnectError,
            httpx.ReadError,
            httpx.WriteError,
            httpx.CloseError,
            httpx.PoolTimeout,
            httpx.RemoteProtocolError,
        ),
    ):
        return SyncError("NETWORK", f"Transient network failure: {exc}", True, None)
    return SyncError("UNEXPECTED", f"Unexpected error: {exc}", True, None)


def _extract_message(body: dict | str | None) -> str:
    if isinstance(body, dict):
        msg = body.get("message")
        if isinstance(msg, str):
            return msg[:500]
        return str(body)[:500]
    if isinstance(body, str):
        return body[:500]
    return ""

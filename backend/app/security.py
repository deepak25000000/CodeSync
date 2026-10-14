"""Token generation, hashing, credential encryption and log redaction helpers."""

from __future__ import annotations

import base64
import hashlib
import secrets
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

API_TOKEN_PREFIX = "cs_"


def generate_api_token() -> tuple[str, str]:
    """Return (plaintext token, sha256 hex digest). Only the digest is stored."""
    raw = secrets.token_urlsafe(32)
    token = f"{API_TOKEN_PREFIX}{raw}"
    return token, hash_api_token(token)


def hash_api_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def generate_state() -> tuple[str, str]:
    """Return (state plaintext, sha256 hex digest) for OAuth state validation."""
    raw = secrets.token_urlsafe(24)
    return raw, hashlib.sha256(raw.encode("utf-8")).hexdigest()


class CredentialCipher:
    """Encrypts/decrypts GitHub tokens at rest. Key comes from env (never committed)."""

    def __init__(self, key: str) -> None:
        self._key = key
        self._fernet: Fernet | None = None

    @property
    def configured(self) -> bool:
        return bool(self._key)

    def _get_fernet(self) -> Fernet:
        if self._fernet is None:
            if not self._key:
                raise RuntimeError(
                    "CREDENTIALS_KEY is not configured; cannot store GitHub credentials."
                )
            # Accept raw Fernet keys as well as 32-byte secrets passed as utf-8/bytes.
            key = self._key.encode("utf-8")
            if len(key) != 32 or not _is_fernet_key(key):
                key = base64.urlsafe_b64encode(hashlib.sha256(self._key.encode("utf-8")).digest())
            self._fernet = Fernet(key)
        return self._fernet

    def encrypt(self, plaintext: str) -> str:
        return self._get_fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt(self, ciphertext: str) -> str:
        try:
            return self._get_fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except InvalidToken as exc:  # pragma: no cover - defensive
            raise RuntimeError("Stored credential could not be decrypted") from exc


def _is_fernet_key(key: bytes) -> bool:
    try:
        Fernet(key)
        return True
    except (ValueError, TypeError):
        return False


SENSITIVE_KEYS = {
    "token",
    "access_token",
    "refresh_token",
    "authorization",
    "client_secret",
    "password",
    "api_token",
    "code",
    "secret",
}


def redact(value: Any, _depth: int = 0) -> Any:
    """Recursively redact sensitive values for safe logging."""
    if _depth > 6:
        return "<truncated>"
    if isinstance(value, dict):
        out: dict[Any, Any] = {}
        for k, v in value.items():
            if isinstance(k, str) and k.lower() in SENSITIVE_KEYS:
                out[k] = "<redacted>"
            else:
                out[k] = redact(v, _depth + 1)
        return out
    if isinstance(value, (list, tuple)):
        return [redact(v, _depth + 1) for v in value]
    if isinstance(value, str) and value.startswith("Bearer "):
        return "Bearer <redacted>"
    return value

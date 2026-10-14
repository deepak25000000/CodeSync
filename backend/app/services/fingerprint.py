"""Stable content fingerprinting for duplicate detection."""

from __future__ import annotations

import hashlib
import re


def normalize_code(code: str | None) -> str:
    if not code:
        return ""
    text = code.replace("\r\n", "\n").replace("\r", "\n")
    # Trailing whitespace per line is insignificant for dedupe purposes.
    lines = [ln.rstrip() for ln in text.split("\n")]
    return "\n".join(lines).strip()


def content_hash(code: str | None) -> str:
    return hashlib.sha256(normalize_code(code).encode("utf-8")).hexdigest()


def stable_fingerprint(
    platform: str,
    external_id: str | None,
    url: str | None,
    language: str,
    code: str | None,
) -> str:
    """Prefer platform+submission-id identity; fall back to URL+language+content hash.

    The same submission replayed (same platform submission id) and the same code
    submitted twice without an id both map to one fingerprint, so duplicate events
    can never create duplicate commits.
    """
    platform = (platform or "").strip().lower()
    ext = (external_id or "").strip()
    if platform and ext:
        basis = f"id|{platform}|{ext}"
    else:
        basis = f"content|{platform}|{(url or '').strip()}|{(language or '').strip().lower()}|{content_hash(code)}"
    return hashlib.sha256(basis.encode("utf-8")).hexdigest()


def fingerprint_marker(fingerprint: str) -> str:
    return f"codesync-fp:{fingerprint}"


def find_marker(haystack: str) -> str | None:
    m = re.search(r"codesync-fp:([0-9a-f]{64})", haystack or "")
    return m.group(1) if m else None

"""In-memory sliding-window rate limiter (per key, e.g. API token hash)."""

from __future__ import annotations

import threading
import time
from collections import deque


class SlidingWindowRateLimiter:
    def __init__(self, max_requests: int, window_seconds: int) -> None:
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._hits: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def check(self, key: str) -> tuple[bool, int, float]:
        """Return (allowed, remaining, retry_after_seconds)."""
        now = time.monotonic()
        cutoff = now - self.window_seconds
        with self._lock:
            q = self._hits.setdefault(key, deque())
            while q and q[0] <= cutoff:
                q.popleft()
            if len(q) >= self.max_requests:
                retry_after = max(0.0, q[0] + self.window_seconds - now)
                return False, 0, retry_after
            q.append(now)
            return True, self.max_requests - len(q), 0.0

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()

"""Bounded exponential backoff with jitter."""

from __future__ import annotations

import random


def compute_backoff(
    attempt: int,
    base: float = 2.0,
    factor: float = 2.0,
    cap: float = 300.0,
    jitter: bool = True,
    rng: random.Random | None = None,
) -> float:
    """Return seconds to wait before the next attempt (attempt is 1-based)."""
    if attempt < 1:
        attempt = 1
    delay = min(cap, base * (factor ** (attempt - 1)))
    if jitter:
        r = rng or random
        # equal jitter: half fixed, half random in [0, delay/2]
        delay = delay / 2 + r.uniform(0, delay / 2)
    return max(0.0, min(cap, delay))


def should_retry(attempts_made: int, max_attempts: int) -> bool:
    return attempts_made < max_attempts

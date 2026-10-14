"""Authoritative platform capability matrix (mirrors extension adapters).

Every claim here is verified by fixture tests; see docs/CAPABILITY_MATRIX.md.
"""

from __future__ import annotations

from typing import Any

PLATFORMS: dict[str, dict[str, Any]] = {
    "leetcode": {
        "name": "LeetCode",
        "hosts": ["leetcode.com", "leetcode.cn"],
        "url_patterns": [
            r"^https?://(www\.)?leetcode\.com/problems/[^/]+/submissions/\d+/?",
            r"^https?://(www\.)?leetcode\.com/problems/[^/]+/solutions?/",
            r"^https?://(www\.)?leetcode\.com/submissions/?",
        ],
        "capabilities": {
            "submission_detection": True,
            "verdict_extraction": True,
            "solution_code_extraction": True,
            "problem_metadata": True,
            "submission_id": True,
            "timestamp": True,
            "requires_login": True,
            "notes": "DOM-based; falls back through several selectors. Fixture-tested; "
            "live verification pending.",
        },
    },
    "geeksforgeeks": {
        "name": "GeeksforGeeks",
        "hosts": ["geeksforgeeks.org"],
        "url_patterns": [
            r"^https?://(www\.)?geeksforgeeks\.org/problems/[^/]+",
            r"^https?://(www\.)?geeksforgeeks\.org/problems/[^/]+/[^/]*investigate",
            r"^https?://(www\.)?geeksforgeeks\.org/user/[^/]+/submissions",
        ],
        "capabilities": {
            "submission_detection": True,
            "verdict_extraction": True,
            "solution_code_extraction": True,
            "problem_metadata": True,
            "submission_id": False,
            "timestamp": True,
            "requires_login": True,
            "notes": "Code often only present on the submission/result page. Fixture-tested.",
        },
    },
    "codechef": {
        "name": "CodeChef",
        "hosts": ["codechef.com"],
        "url_patterns": [
            r"^https?://(www\.)?codechef\.com/problems/[^/]+",
            r"^https?://(www\.)?codechef\.com/submissions/[^/]+",
            r"^https?://(www\.)?codechef\.com/api/me/submissions",
        ],
        "capabilities": {
            "submission_detection": True,
            "verdict_extraction": True,
            "solution_code_extraction": True,
            "problem_metadata": True,
            "submission_id": True,
            "timestamp": True,
            "requires_login": True,
            "notes": "Verdict parsed from result panel; code from editor/result view. Fixture-tested.",
        },
    },
    "neetcode": {
        "name": "NeetCode",
        "hosts": ["neetcode.io"],
        "url_patterns": [
            r"^https?://(www\.)?neetcode\.io/practice",
            r"^https?://(www\.)?neetcode\.io/roadmap",
            r"^https?://(www\.)?neetcode\.io/problems/[^/]+",
            r"^https?://(www\.)?neetcode\.io/[^/]+",
        ],
        "capabilities": {
            "submission_detection": False,
            "verdict_extraction": False,
            "solution_code_extraction": False,
            "problem_metadata": True,
            "submission_id": False,
            "timestamp": False,
            "requires_login": False,
            "notes": "NeetCode is a practice organizer, not a judge. It does not expose an "
            "accepted-submission event. Supported: problem metadata + association with the "
            "linked coding platform + explicit manual sync of a solution the user pastes.",
        },
    },
}


def platform_matrix(enabled_map: dict[str, bool] | None = None) -> list[dict[str, Any]]:
    out = []
    for pid, info in PLATFORMS.items():
        out.append(
            {
                "id": pid,
                "name": info["name"],
                "enabled": (enabled_map or {}).get(pid, True),
                "capabilities": {
                    **info["capabilities"],
                    "hosts": info["hosts"],
                    "url_patterns": info["url_patterns"],
                },
            }
        )
    return out

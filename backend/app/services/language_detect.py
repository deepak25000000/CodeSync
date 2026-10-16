"""Last-resort language detection from the solution's own code.

The extension detects the language from the platform DOM / editor bridge; this
module is the backend's safety net for submissions that still arrive as
``unknown`` (e.g. a site redesign hiding its language control). Without it the
sync would fail with INVALID_FILE even though the code makes the language
obvious — a permanent, unrecoverable failure for that submission.

Every name returned here is a key the backend's LANGUAGE_EXTENSIONS map knows,
so :func:`app.services.filegen.language_to_extension` always succeeds with it.
"""

from __future__ import annotations

import re

_RULES: list[tuple[str, re.Pattern[str]]] = [
    ("PHP", re.compile(r"<\?php\b", re.IGNORECASE)),
    (
        "Python3",
        re.compile(
            r"(?:^|\n)[ \t]*(?:def\s+\w+\s*\([^)]*\)\s*(?:->[^\n]*)?:"
            r"|class\s+\w+\s*:(?=\n|$)"
            r"|from\s+[\w.]+\s+import\s+\w"
            r"|import\s+(?:numpy|sys|collections|math|typing|re|heapq|itertools|functools)\b)"
        ),
    ),
    (
        "Java",
        re.compile(
            r"\bSystem\.out\.print|\bpublic\s+(?:static|class)\b"
            r"|\bnew\s+(?:ArrayList|HashMap|StringBuilder)<"
        ),
    ),
    (
        "C++",
        re.compile(
            r"\busing\s+namespace\s+std\s*;|\bstd::"
            r"|#include\s*<(?:vector|string|iostream|map|algorithm|set|queue|stack|unordered_map)>"
        ),
    ),
    ("C#", re.compile(r"\busing\s+System\s*;|Console\.WriteLine")),
    ("C", re.compile(r"#include\s*<stdio\.h>|\b(?:int|void)\s+main\s*\(|\bprintf\s*\(")),
    ("Go", re.compile(r"\bfmt\.(?:Print|Sprintf)|\bpackage\s+main\b")),
    ("Rust", re.compile(r"\bfn\s+main\s*\(|println!|\blet\s+mut\s+")),
    ("Kotlin", re.compile(r"(?:^|\n)[ \t]*fun\s+\w+")),
    ("Swift", re.compile(r"\bfunc\s+\w+\s*\(|import\s+Foundation")),
    ("TypeScript", re.compile(r"interface\s+\w+\s*\{|:\s*(?:string|number|boolean)\s*[;)=,]")),
    (
        "JavaScript",
        re.compile(r"console\.log\s*\(|=>|\b(?:const|let)\s+\w+\s*=|\bclass\s+\w+\s*\{"),
    ),
    ("Ruby", re.compile(r"(?:^|\n)[ \t]*(?:puts\s|require\s+['\"])")),
    ("Elixir", re.compile(r"\bdefmodule\s+\w+\s+do\b|\bdefp\s+\w+")),
    ("Erlang", re.compile(r"-module\(|-export\(")),
    ("Scala", re.compile(r"\bobject\s+\w+\s+extends\b")),
    ("Dart", re.compile(r"import\s+['\"]package:")),
    ("Bash", re.compile(r"#!\s*/bin/(?:ba)?sh|(?:^|\n)[ \t]*echo\s")),
    (
        "MySQL",
        re.compile(
            r"(?:^|\n)[ \t]*(?:select\b[\s\S]*?\bfrom\b|insert\s+into\b|create\s+table\b)",
            re.IGNORECASE,
        ),
    ),
]


def sniff_language(code: str | None) -> str | None:
    """Infer a canonical language name from code syntax; None when unsure.

    Ordered strong-first: each rule only fires when an earlier, more specific
    rule did not (e.g. C++ includes/namespace before bare C printf). A wrong
    guess is never worse than ``unknown`` (which is rejected outright), but
    rules stay conservative so confident matches dominate in practice.
    """
    if not code or not code.strip():
        return None
    for name, pattern in _RULES:
        if pattern.search(code):
            return name
    return None

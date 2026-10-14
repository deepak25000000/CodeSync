"""Repository path building, filename sanitization and file content generation."""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import UTC, datetime

from app.models import Platform, Submission, UserSettings
from app.services.fingerprint import fingerprint_marker

PLATFORM_DIRS: dict[str, str] = {
    Platform.leetcode.value: "LeetCode",
    Platform.geeksforgeeks.value: "GeeksforGeeks",
    Platform.codechef.value: "CodeChef",
    Platform.neetcode.value: "NeetCode",
}

LANGUAGE_EXTENSIONS: dict[str, str] = {
    "python": "py",
    "python3": "py",
    "cpp": "cpp",
    "c++": "cpp",
    "c": "c",
    "java": "java",
    "javascript": "js",
    "js": "js",
    "node": "js",
    "typescript": "ts",
    "ts": "ts",
    "csharp": "cs",
    "c#": "cs",
    "kotlin": "kt",
    "swift": "swift",
    "golang": "go",
    "go": "go",
    "rust": "rs",
    "ruby": "rb",
    "php": "php",
    "scala": "scala",
    "dart": "dart",
    "r": "r",
    "elixir": "ex",
    "haskell": "hs",
    "perl": "pl",
    "bash": "sh",
    "shell": "sh",
    "sql": "sql",
    "mysql": "sql",
    "oracle": "sql",
    "mariadb": "sql",
    "pypy": "py",
    "pypy3": "py",
    # common aliases (language or bare extension)
    "py": "py",
    "kt": "kt",
    "cs": "cs",
    "rs": "rs",
    "rb": "rb",
    "hs": "hs",
    "ex": "ex",
    "pl": "pl",
    "lua": "lua",
    "ml": "ml",
}

SUPPORTED_LANGUAGES = sorted(set(LANGUAGE_EXTENSIONS))


class UnsupportedLanguageError(ValueError):
    pass


class FilenameError(ValueError):
    pass


def language_to_extension(language: str) -> str:
    key = (language or "").strip().lower()
    ext = LANGUAGE_EXTENSIONS.get(key)
    if ext is None:
        raise UnsupportedLanguageError(f"Unsupported programming language: {language!r}")
    return ext


def sanitize_slug(text: str, max_length: int = 80) -> str:
    """ASCII-safe, lowercase, hyphen-delimited slug; Unicode titles are normalized."""
    if not text or not text.strip():
        raise FilenameError("Cannot build a filename from an empty title")
    normalized = unicodedata.normalize("NFKD", text.strip())
    ascii_text = normalized.encode("ascii", "ignore").decode("ascii")
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_text).strip("-").lower()
    if not slug:
        # Fully non-ASCII title (e.g. CJK): keep unicode word chars rather than
        # transliterating (guessing would be wrong and risks collisions).
        slug = re.sub(r"[^\w]+", "-", text.strip(), flags=re.UNICODE).strip("-").lower()
    slug = re.sub(r"-{2,}", "-", slug)
    if not slug:
        raise FilenameError(f"Cannot build a filename from title {text!r}")
    return slug[:max_length].strip("-")


def problem_number(problem_id: str | None) -> str | None:
    if not problem_id:
        return None
    m = re.fullmatch(r"0*(\d{1,6})", problem_id.strip())
    if m:
        return m.group(1).zfill(4)
    return None


def build_filename(submission_like: dict) -> str:
    """Build `0001-two-sum.py` style filename from a plain dict."""
    ext = language_to_extension(submission_like.get("language", ""))
    slug = sanitize_slug(submission_like.get("title") or "")
    number = problem_number(submission_like.get("problem_id"))
    stem = f"{number}-{slug}" if number else slug
    filename = f"{stem}.{ext}"
    if len(filename) > 120:
        filename = f"{slug[:100].strip('-')}.{ext}"
    return filename


def build_repo_path(settings: UserSettings, platform: str, submission_like: dict) -> str:
    platform_dir = PLATFORM_DIRS.get(platform)
    if platform_dir is None:
        raise FilenameError(f"Unknown platform: {platform!r}")
    root = (
        sanitize_slug(settings.root_folder or "DSA-Solutions")
        if settings.root_folder
        else "DSA-Solutions"
    )
    # root folder keeps user-provided casing if it is already safe
    root = settings.root_folder.strip("/ ") or "DSA-Solutions"
    if not re.fullmatch(r"[A-Za-z0-9._\- ]+", root):
        root = sanitize_slug(root)
    filename = build_filename(submission_like)
    return f"{root}/{platform_dir}/{filename}"


_HEADER_LANG = {
    "py": "#",
    "sh": "#",
    "rb": "#",
    "r": "#",
    "sql": "--",
    "ml": "(*",
}
_BLOCK_LANG = {
    "ts",
    "js",
    "cpp",
    "c",
    "java",
    "cs",
    "kt",
    "swift",
    "go",
    "rs",
    "php",
    "scala",
    "dart",
    "hs",
    "ex",
    "pl",
    "lua",
}


def _comment_lines(language: str, lines: list[str]) -> str:
    ext = LANGUAGE_EXTENSIONS.get((language or "").strip().lower(), "")
    if ext in _HEADER_LANG:
        prefix = _HEADER_LANG[ext]
        if ext == "ml":
            inner = "\n".join(f"  {ln}" for ln in lines)
            return f"(*\n{inner}\n*)"
        return "\n".join(f"{prefix} {ln}" for ln in lines)
    if ext in _BLOCK_LANG:
        return "/*\n" + "\n".join(f"  {ln}" for ln in lines) + "\n*/"
    return "\n".join(f"# {ln}" for ln in lines)


def build_file_content(
    submission: Submission,
    fingerprint: str,
    repo_full_name: str,
    synced_at: datetime | None = None,
) -> str:
    """Header metadata + the user's original, unmodified solution code."""
    ts = (synced_at or datetime.now(UTC)).isoformat()
    header_lines = [
        fingerprint_marker(fingerprint),
        f"Problem: {submission.title}",
        f"Platform: {submission.platform}",
    ]
    if submission.url:
        header_lines.append(f"URL: {submission.url}")
    if submission.problem_id:
        header_lines.append(f"Problem ID: {submission.problem_id}")
    if submission.external_id:
        header_lines.append(f"Submission ID: {submission.external_id}")
    header_lines.append(f"Language: {submission.language}")
    if submission.submitted_at:
        header_lines.append(f"Submitted: {submission.submitted_at.isoformat()}")
    header_lines.append(f"Synced-at: {ts}")
    header_lines.append(f"Repository: {repo_full_name}")

    header = _comment_lines(submission.language, header_lines)
    code = (submission.code or "").replace("\r\n", "\n").replace("\r", "\n")
    return f"{header}\n\n{code.rstrip()}\n"


def build_progress_json(
    existing: bytes | None,
    submission: Submission,
    fingerprint: str,
    repo_full_name: str,
    synced_at: datetime | None = None,
) -> bytes:
    """Merge a submission into progress.json (safe, idempotent by fingerprint)."""
    ts = (synced_at or datetime.now(UTC)).isoformat()
    data: dict
    if existing:
        try:
            parsed = json.loads(existing.decode("utf-8"))
            data = parsed if isinstance(parsed, dict) else {}
        except (ValueError, UnicodeDecodeError):
            data = {}
    else:
        data = {}
    data.setdefault("schema", 1)
    data.setdefault("repository", repo_full_name)
    platforms = data.setdefault("platforms", {})
    entry_list = platforms.setdefault(submission.platform, {}).setdefault("problems", [])
    if not isinstance(entry_list, list):
        entry_list = []
        platforms[submission.platform]["problems"] = entry_list
    if not any(isinstance(p, dict) and p.get("fingerprint") == fingerprint for p in entry_list):
        entry_list.append(
            {
                "fingerprint": fingerprint,
                "title": submission.title,
                "problem_id": submission.problem_id,
                "url": submission.url,
                "language": submission.language,
                "synced_at": ts,
            }
        )
    for _platform, pdata in platforms.items():
        if isinstance(pdata, dict) and isinstance(pdata.get("problems"), list):
            pdata["count"] = len(pdata["problems"])
    data["updated_at"] = ts
    return (json.dumps(data, indent=2, ensure_ascii=False, sort_keys=False) + "\n").encode("utf-8")


README_BEGIN = "<!-- codesync:progress:begin -->"
README_END = "<!-- codesync:progress:end -->"


def update_readme(existing: bytes | None, platforms: dict[str, int]) -> bytes:
    """Upsert the CodeSync progress section between markers; never touch other content."""
    text = existing.decode("utf-8") if existing else "# CodeSync Solutions\n"
    rows = [
        f"| {PLATFORM_DIRS.get(p, p)} | {count} |"
        for p, count in sorted(platforms.items(), key=lambda kv: PLATFORM_DIRS.get(kv[0], kv[0]))
    ]
    if not rows:
        rows = ["| - | 0 |"]
    section = (
        f"{README_BEGIN}\n"
        "## CodeSync Progress\n"
        "| Platform | Solutions |\n"
        "|---|---|\n" + "\n".join(rows) + f"\n{README_END}"
    )
    pattern = re.compile(re.escape(README_BEGIN) + r".*?" + re.escape(README_END), re.DOTALL)
    if pattern.search(text):
        updated = pattern.sub(lambda _m: section, text, count=1)
    else:
        updated = text.rstrip() + "\n\n" + section + "\n"
    return updated.encode("utf-8")

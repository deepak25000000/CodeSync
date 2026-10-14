"""Unit tests: filename/path building, file content generation, progress + README."""

from __future__ import annotations

import json

import pytest

from app.models import Submission, UserSettings
from app.services.filegen import (
    README_BEGIN,
    README_END,
    UnsupportedLanguageError,
    build_file_content,
    build_filename,
    build_progress_json,
    build_repo_path,
    language_to_extension,
    sanitize_slug,
    update_readme,
)


def make_submission(**kw) -> Submission:
    defaults = {
        "platform": "leetcode",
        "title": "Two Sum",
        "problem_id": "1",
        "language": "python",
        "code": "class Solution:\n    pass\n",
        "url": "https://leetcode.com/problems/two-sum/",
        "external_id": "12345",
        "fingerprint": "f" * 64,
    }
    defaults.update(kw)
    return Submission(**defaults)


class TestLanguages:
    @pytest.mark.parametrize(
        "language,ext",
        [
            ("python", "py"),
            ("Python3", "py"),
            ("C++", "cpp"),
            ("c#", "cs"),
            ("Go", "go"),
            ("JS", "js"),
        ],
    )
    def test_known_languages(self, language, ext):
        assert language_to_extension(language) == ext

    def test_unknown_language_raises(self):
        with pytest.raises(UnsupportedLanguageError):
            language_to_extension("brainfuck")

    def test_filename_uses_number_and_slug(self):
        assert (
            build_filename({"title": "Two Sum", "language": "python", "problem_id": "1"})
            == "0001-two-sum.py"
        )

    def test_filename_without_number(self):
        assert (
            build_filename({"title": "Merge Intervals", "language": "cpp", "problem_id": None})
            == "merge-intervals.cpp"
        )

    def test_filename_zero_padding(self):
        assert build_filename({"title": "X", "language": "py", "problem_id": "007"}) == "0007-x.py"

    def test_non_numeric_problem_id_ignored(self):
        assert build_filename({"title": "X", "language": "py", "problem_id": "LC-12"}) == "x.py"


class TestSlug:
    def test_basic(self):
        assert sanitize_slug("  Two Sum!! ") == "two-sum"

    def test_unicode_latin(self):
        assert sanitize_slug("Café Résumé") == "cafe-resume"

    def test_fully_non_ascii_falls_back_without_crash(self):
        slug = sanitize_slug("两数之和")
        assert slug and " " not in slug

    def test_empty_raises(self):
        from app.services.filegen import FilenameError

        with pytest.raises(FilenameError):
            sanitize_slug("   ")


class TestRepoPath:
    def test_layout(self):
        settings = UserSettings(user_id=1, root_folder="DSA-Solutions")
        path = build_repo_path(
            settings, "leetcode", {"title": "Two Sum", "language": "python", "problem_id": "1"}
        )
        assert path == "DSA-Solutions/LeetCode/0001-two-sum.py"

    def test_all_platform_dirs(self):
        settings = UserSettings(user_id=1, root_folder="Solutions")
        for platform, folder in [
            ("leetcode", "LeetCode"),
            ("geeksforgeeks", "GeeksforGeeks"),
            ("codechef", "CodeChef"),
            ("neetcode", "NeetCode"),
        ]:
            path = build_repo_path(settings, platform, {"title": "A B", "language": "py"})
            assert path.startswith(f"Solutions/{folder}/")

    def test_unknown_platform(self):
        from app.services.filegen import FilenameError

        settings = UserSettings(user_id=1, root_folder="Solutions")
        with pytest.raises(FilenameError):
            build_repo_path(settings, "hackerrank", {"title": "X", "language": "py"})


class TestFileContent:
    def test_header_and_code(self):
        sub = make_submission()
        content = build_file_content(sub, "f" * 64, "octo/dsa")
        assert "codesync-fp:" + "f" * 64 in content
        assert "Problem: Two Sum" in content
        assert "Platform: leetcode" in content
        assert "Repository: octo/dsa" in content
        assert content.rstrip().endswith("pass")

    def test_code_is_not_modified(self):
        code = "def f():\n    return 1\n\n\n"
        content = build_file_content(make_submission(code=code), "f" * 64, "octo/dsa")
        assert code.rstrip() in content

    def test_block_comment_language(self):
        content = build_file_content(
            make_submission(language="cpp", code="int main(){}"), "f" * 64, "octo/dsa"
        )
        assert content.lstrip().startswith("/*")
        assert "int main(){}" in content

    def test_optional_fields_omitted(self):
        sub = make_submission(url=None, problem_id=None, external_id=None, submitted_at=None)
        content = build_file_content(sub, "f" * 64, "octo/dsa")
        assert "URL:" not in content
        assert "Submission ID:" not in content


class TestProgressJson:
    def test_creates_and_merges(self):
        sub = make_submission()
        first = build_progress_json(None, sub, "f" * 64, "octo/dsa")
        data = json.loads(first)
        assert data["schema"] == 1
        assert data["platforms"]["leetcode"]["count"] == 1

        second = build_progress_json(first, sub, "f" * 64, "octo/dsa")
        assert json.loads(second)["platforms"]["leetcode"]["count"] == 1  # idempotent

        other = make_submission(external_id="999", title="Add Two Numbers")
        third = build_progress_json(second, other, "e" * 64, "octo/dsa")
        assert json.loads(third)["platforms"]["leetcode"]["count"] == 2

    def test_corrupt_existing_recovered(self):
        sub = make_submission()
        out = build_progress_json(b"not json", sub, "f" * 64, "octo/dsa")
        assert json.loads(out)["platforms"]["leetcode"]["count"] == 1


class TestReadme:
    def test_creates_section(self):
        out = update_readme(None, {"leetcode": 3})
        text = out.decode()
        assert README_BEGIN in text and README_END in text
        assert "| LeetCode | 3 |" in text

    def test_replaces_existing_section_only(self):
        base = b"# My repo\n\nkeep me\n\n" + update_readme(None, {"leetcode": 1})
        out = update_readme(base, {"leetcode": 9, "codechef": 2})
        text = out.decode()
        assert "keep me" in text
        assert "| LeetCode | 9 |" in text
        assert "| CodeChef | 2 |" in text
        assert text.count(README_BEGIN) == 1

    def test_counts_sorted_by_platform_name(self):
        text = update_readme(None, {"codechef": 1, "leetcode": 2}).decode()
        assert text.index("CodeChef") < text.index("LeetCode")

    def test_empty_counts_placeholder(self):
        text = update_readme(None, {}).decode()
        assert "| - | 0 |" in text

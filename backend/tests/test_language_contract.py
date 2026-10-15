"""Cross-artifact language contract.

The extension canonicalises every detected language through LANG_TOKENS in
``extension/src/adapters/shared.js`` and the backend maps the resulting string
through ``filegen.LANGUAGE_EXTENSIONS``. If the two ever drift apart, syncs die
at runtime with INVALID_FILE ("Unsupported programming language") after the
submission was already accepted — so this contract is enforced here by parsing
the real extension source instead of a hand-maintained copy.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.services.filegen import UnsupportedLanguageError, language_to_extension

SHARED_JS = (
    Path(__file__).resolve().parents[2] / "extension" / "src" / "adapters" / "shared.js"
)


def _extension_language_names() -> list[str]:
    if not SHARED_JS.exists():
        pytest.skip("extension source not present in this checkout")
    source = SHARED_JS.read_text(encoding="utf-8")
    match = re.search(r"export const LANG_TOKENS = \[(.*?)\];", source, re.DOTALL)
    assert match, "LANG_TOKENS block not found in shared.js"
    names = re.findall(r"name:\s*'([^']+)'", match.group(1))
    assert names, "expected to parse at least one language from LANG_TOKENS"
    return names


class TestExtensionLanguageContract:
    def test_every_extension_language_resolves_to_an_extension(self) -> None:
        for name in _extension_language_names():
            ext = language_to_extension(name)  # must not raise
            assert ext and ext.isalnum()

    def test_new_languages_are_discoverable(self) -> None:
        names = _extension_language_names()
        # Spot-check languages added for full LeetCode/CODECHEF coverage.
        for required in ("Python3", "C++", "Elixir", "Erlang", "Node.js", "MS SQL", "Plain Text"):
            assert required in names

    def test_unknown_language_still_rejected(self) -> None:
        with pytest.raises(UnsupportedLanguageError):
            language_to_extension("brainfuck")
        with pytest.raises(UnsupportedLanguageError):
            language_to_extension("unknown")

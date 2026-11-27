"""Neutralise text written by an agent so that posting it to GitHub notifies, links, fetches and renders nothing."""

import re
import unicodedata

ZWSP = chr(0x200B)
_TRUNCATED = "\n\n(truncated)"
_CHARACTER_REFERENCE = re.compile(r"&(?=#|[A-Za-z][A-Za-z0-9]*;)")
_EMBED_TAG = re.compile(r"<(?=(?:img|image))", re.IGNORECASE)
_IMAGE_MARK = re.compile(r"!+\[")
_CLOSING_KEYWORD = re.compile(
    r"(?<![A-Za-z0-9])(close[sd]?|fix(?:es|ed)?|resolve[sd]?)(?![A-Za-z0-9])", re.IGNORECASE
)
_MERMAID = re.compile(r"mermaid", re.IGNORECASE)


def _keep(char: str) -> bool:
    return char in "\n\t" or unicodedata.category(char) != "Cc"


def neutralise(text: str, limit: int) -> str:
    """Apply the rules below in this order, everywhere, code spans included, then cut to `limit`.

    1. Remove control characters other than newline and tab.
    2. An `&` that starts a character reference becomes `&amp;`, so no reference can hide a trigger.
    3. `<!--` becomes `&lt;!--`; `<img` and `<image` in any letter case become `&lt;img`, `&lt;image`.
    4. Every run of `!` directly before `[` is removed, so an image becomes a link.
    5. `@` before a letter or digit, `#` or `GH-` before a digit get a ZWSP after them.
    6. A closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved)
       standing as a whole word, neither preceded nor followed by an ASCII letter or digit, gets a
       ZWSP after its first letter, whatever follows it.
    7. The word `mermaid` gets a ZWSP after its first letter, wherever it appears, so no diagram renders.
    8. A result longer than `limit` is cut and ends with the truncation mark.

    Apply this exactly once to a text: a second pass would escape its own `&amp;` and `&lt;`. Inside
    code spans an `&` that starts a character reference is shown as a literal `&amp;`, an accepted
    cost of treating code like any other text.
    """
    if limit < len(_TRUNCATED):
        raise ValueError(f"limit must be at least {len(_TRUNCATED)}")
    text = "".join(char for char in text if _keep(char))
    text = _CHARACTER_REFERENCE.sub("&amp;", text)
    text = text.replace("<!--", "&lt;!--")
    text = _EMBED_TAG.sub("&lt;", text)
    text = _IMAGE_MARK.sub("[", text)
    text = re.sub(r"@(?=[A-Za-z0-9])", "@" + ZWSP, text)
    text = re.sub(r"#(?=\d)", "#" + ZWSP, text)
    text = re.sub(r"(GH-)(?=\d)", r"\1" + ZWSP, text, flags=re.IGNORECASE)
    text = _CLOSING_KEYWORD.sub(lambda m: m[0][0] + ZWSP + m[0][1:], text)
    text = _MERMAID.sub(lambda m: m[0][0] + ZWSP + m[0][1:], text)
    if len(text) > limit:
        text = text[: limit - len(_TRUNCATED)] + _TRUNCATED
    return text


def single_line(text: str, limit: int) -> str:
    """Collapse whitespace runs to single spaces, neutralise, and collapse again so a cut stays on one line."""
    return " ".join(neutralise(" ".join(text.split()), limit).split())

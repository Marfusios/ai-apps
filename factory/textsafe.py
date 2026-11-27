"""Neutralise text written by an agent so that posting it to GitHub notifies, links, fetches and renders nothing."""

import re
import unicodedata

ZWSP = chr(0x200B)
_TRUNCATED = "\n\n(truncated)"
_CHARACTER_REFERENCE = re.compile(r"&(?=#|[A-Za-z][A-Za-z0-9]*;)")
_EMBED_TAG = re.compile(r"<(?=(?:img|image))", re.IGNORECASE)
_IMAGE_MARK = re.compile(r"!+\[")
_CLOSING_KEYWORD = re.compile(
    r"\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)([^A-Za-z0-9\n]{0,10}(?:https?://|\[))", re.IGNORECASE
)
_MERMAID_FENCE = re.compile(r"^( *(?:`{3,}|~{3,}) *)mermaid\b", re.IGNORECASE | re.MULTILINE)


def _keep(char: str) -> bool:
    return char in "\n\t" or unicodedata.category(char) != "Cc"


def neutralise(text: str, limit: int) -> str:
    """Apply the rules below in this order, everywhere, code spans included, then cut to `limit`.

    1. Remove control characters other than newline and tab.
    2. An `&` that starts a character reference becomes `&amp;`, so no reference can hide a trigger.
    3. `<!--` becomes `&lt;!--`; `<img` and `<image` in any letter case become `&lt;img`, `&lt;image`.
    4. Every run of `!` directly before `[` is removed, so an image becomes a link.
    5. `@` before a letter or digit, `#` or `GH-` before a digit get a ZWSP after them.
    6. A closing keyword followed by up to 10 non-alphanumeric characters and a URL or `[`
       gets a ZWSP after its first letter.
    7. A fenced block whose info string is `mermaid` becomes `text`.
    8. A result longer than `limit` is cut and ends with the truncation mark.
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
    text = _CLOSING_KEYWORD.sub(lambda m: m[1][0] + ZWSP + m[1][1:] + m[2], text)
    text = _MERMAID_FENCE.sub(r"\1text", text)
    if len(text) > limit:
        text = text[: limit - len(_TRUNCATED)] + _TRUNCATED
    return text


def single_line(text: str, limit: int) -> str:
    """Collapse whitespace runs to single spaces, neutralise, and collapse again so a cut stays on one line."""
    return " ".join(neutralise(" ".join(text.split()), limit).split())

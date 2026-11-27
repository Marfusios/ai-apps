"""Neutralise text written by an agent so that posting it to GitHub notifies, links and fetches nothing."""

import re
import unicodedata

ZWSP = "\u200b"
_TRUNCATED = "\n\n(truncated)"
_CLOSING_KEYWORD = re.compile(
    r"\b(close[sd]?|fix(?:es|ed)?|resolve[sd]?)(:?\s+)(?=https?://)", re.IGNORECASE
)


def _keep(char: str) -> bool:
    return char in "\n\t" or unicodedata.category(char) != "Cc"


def neutralise(text: str, limit: int) -> str:
    """Apply the text-safety rules everywhere, code spans included, and cut the result to `limit`."""
    text = "".join(char for char in text if _keep(char))
    text = text.replace("<!--", "&lt;!--")
    text = re.sub(r"<(?=img)", "&lt;", text, flags=re.IGNORECASE)
    text = text.replace("![", "[")
    text = re.sub(r"@(?=[A-Za-z0-9])", "@" + ZWSP, text)
    text = re.sub(r"#(?=\d)", "#" + ZWSP, text)
    text = re.sub(r"(GH-)(?=\d)", r"\1" + ZWSP, text, flags=re.IGNORECASE)
    text = _CLOSING_KEYWORD.sub(lambda m: m[1][0] + ZWSP + m[1][1:] + m[2], text)
    if len(text) > limit:
        text = text[: limit - len(_TRUNCATED)] + _TRUNCATED
    return text


def single_line(text: str, limit: int) -> str:
    """Collapse whitespace runs to single spaces, strip the ends, then neutralise."""
    return neutralise(" ".join(text.split()), limit)

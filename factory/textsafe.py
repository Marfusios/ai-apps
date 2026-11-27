"""Neutralise text written by an agent so that posting it to GitHub notifies, links, fetches and renders nothing."""

import re
import unicodedata

ZWSP = chr(0x200B)
LINE_SEPARATORS = "  "  # the line and paragraph separators, which some readers take for line ends
_TRUNCATED = "\n\n(truncated)"
_CHARACTER_REFERENCE = re.compile(r"&(?=#|[A-Za-z][A-Za-z0-9]*;)")
_AUTOLINK = re.compile(r"<(https?://[^\s>]+)>", re.IGNORECASE)
_MARKUP_START = re.compile(r"<(?=[A-Za-z/!?])")
_IMAGE_MARK = re.compile(r"!+\[")
_CLOSING_KEYWORD = re.compile(
    r"(?<![A-Za-z0-9])(close[sd]?|fix(?:es|ed)?|resolve[sd]?)(?![A-Za-z0-9])", re.IGNORECASE
)
_GITHUB_URL = re.compile(r"(github\.com/)", re.IGNORECASE)
_FOOTNOTE = re.compile(r"\[(?=\^)")
_TASK_BOX = re.compile(r"\[(?=[ xX]\])")
_MERMAID = re.compile(r"mermaid", re.IGNORECASE)


def _keep(char: str) -> bool:
    return char in "\n\t" or (unicodedata.category(char) != "Cc" and char not in LINE_SEPARATORS)


def neutralise(text: str, limit: int) -> str:
    """Apply the rules below in this order, everywhere, code spans included, then cut to `limit`.

    1. Remove control characters other than newline and tab, and the line and paragraph separators U+2028 and
       U+2029, so that a line ends only where a newline ends it.
    2. An `&` that starts a character reference becomes `&amp;`, so no reference can hide a trigger.
    3. An angle-bracket autolink, `<` then `http://` or `https://`, non-space characters and `>`, loses its two
       brackets and keeps the bare URL, so an honest `<https://example.com/docs>` still renders as a link. The
       rules below still apply to the URL.
    4. `<` followed by an ASCII letter, `/`, `!` or `?` gets a ZWSP after it, so no HTML tag, closing
       tag, comment or processing instruction survives. Any other `<` is left alone.
    5. Every run of `!` directly before `[` is removed, so an image becomes a link.
    6. `@` before a letter or digit, `#` or `GH-` before a digit get a ZWSP after them.
    7. `github.com/` in any letter case gets a ZWSP after the slash, so no GitHub URL in the text
       resolves to an issue, pull request, commit or user.
    8. `[^` gets a ZWSP between its two characters, so no footnote reference or definition survives.
    9. `[` directly followed by ` ]`, `x]` or `X]` gets a ZWSP after it, so no task-list box survives.
    10. A closing keyword (close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved)
       standing as a whole word, neither preceded nor followed by an ASCII letter or digit, gets a
       ZWSP after its first letter, whatever follows it.
    11. The word `mermaid` gets a ZWSP after its first letter, wherever it appears, so no diagram renders.
    12. A result longer than `limit` is cut and ends with the truncation mark.

    Apply this exactly once to a text: a second pass would escape its own `&amp;`. Inside
    code spans an `&` that starts a character reference is shown as a literal `&amp;`, an accepted
    cost of treating code like any other text.
    """
    if limit < len(_TRUNCATED):
        raise ValueError(f"limit must be at least {len(_TRUNCATED)}")
    text = "".join(char for char in text if _keep(char))
    text = _CHARACTER_REFERENCE.sub("&amp;", text)
    text = _AUTOLINK.sub(lambda m: m[1], text)
    text = _MARKUP_START.sub(lambda m: m[0] + ZWSP, text)
    text = _IMAGE_MARK.sub("[", text)
    text = re.sub(r"@(?=[A-Za-z0-9])", "@" + ZWSP, text)
    text = re.sub(r"#(?=\d)", "#" + ZWSP, text)
    text = re.sub(r"(GH-)(?=\d)", r"\1" + ZWSP, text, flags=re.IGNORECASE)
    text = _GITHUB_URL.sub(lambda m: m[0] + ZWSP, text)
    text = _FOOTNOTE.sub(lambda m: m[0] + ZWSP, text)
    text = _TASK_BOX.sub(lambda m: m[0] + ZWSP, text)
    text = _CLOSING_KEYWORD.sub(lambda m: m[0][0] + ZWSP + m[0][1:], text)
    text = _MERMAID.sub(lambda m: m[0][0] + ZWSP + m[0][1:], text)
    if len(text) > limit:
        text = text[: limit - len(_TRUNCATED)] + _TRUNCATED
    return text


def single_line(text: str, limit: int) -> str:
    """Collapse whitespace runs to single spaces, neutralise, and collapse again so a cut stays on one line."""
    return " ".join(neutralise(" ".join(text.split()), limit).split())

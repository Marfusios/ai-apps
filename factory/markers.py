"""The machine-readable markers the bot puts in its own comments so it can recognise them."""

import json
import re
from collections.abc import Mapping

PREFIX = "<!-- factory:v1 "  # how every marker starts, so that a reader can cut a comment's text before it
REVIEW_PREFIX = "<!-- factory-review:v1 "  # the review's marker: a different prefix, so the two never match each other
_SUFFIX = " -->"
_MARKER = re.compile(re.escape(PREFIX) + r"(.*?)" + re.escape(_SUFFIX))
_REVIEW_MARKER = re.compile(re.escape(REVIEW_PREFIX) + r"(.*?)" + re.escape(_SUFFIX))


def _encode(prefix: str, data: Mapping[str, object]) -> str:
    payload = json.dumps(data, sort_keys=True, separators=(",", ":"))
    payload = payload.replace("<", r"\u003c").replace(">", r"\u003e")
    return prefix + payload + _SUFFIX


def _parse(pattern: re.Pattern[str], body: str) -> dict | None:
    found = pattern.findall(body)
    if not found:
        return None
    try:
        value = json.loads(found[-1])
    except (ValueError, RecursionError):
        return None
    return value if isinstance(value, dict) else None


def encode(data: Mapping[str, object]) -> str:
    """One-line HTML comment holding the data; angle brackets are escaped so it cannot end early."""
    return _encode(PREFIX, data)


def parse(body: str) -> dict | None:
    """The object held by the last marker in a text, or None when there is none or it is not an object."""
    return _parse(_MARKER, body)


def encode_review(data: Mapping[str, object]) -> str:
    """The review's marker, written like `encode` with its own prefix."""
    return _encode(REVIEW_PREFIX, data)


def parse_review(body: str) -> dict | None:
    """The object held by the last review marker in a text, read like `parse`."""
    return _parse(_REVIEW_MARKER, body)

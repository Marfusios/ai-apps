"""The machine-readable marker the bot puts in its own comments so it can recognise them."""

import json
import re
from collections.abc import Mapping

_PREFIX = "<!-- factory:v1 "
_SUFFIX = " -->"
_MARKER = re.compile(re.escape(_PREFIX) + r"(.*?)" + re.escape(_SUFFIX))


def encode(data: Mapping[str, object]) -> str:
    """One-line HTML comment holding the data; angle brackets are escaped so it cannot end early."""
    payload = json.dumps(data, sort_keys=True, separators=(",", ":"))
    payload = payload.replace("<", r"\u003c").replace(">", r"\u003e")
    return _PREFIX + payload + _SUFFIX


def parse(body: str) -> dict | None:
    """The object held by the last marker in a text, or None when there is none or it is not an object."""
    found = _MARKER.findall(body)
    if not found:
        return None
    try:
        value = json.loads(found[-1])
    except ValueError:
        return None
    return value if isinstance(value, dict) else None

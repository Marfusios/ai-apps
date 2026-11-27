"""Patterns for credentials, personal paths and private addresses, shared by the repository checker and the dispatcher."""

import ipaddress
import itertools
import re
import unicodedata
from pathlib import PurePath

PRIVATE_NETWORKS = tuple(
    ipaddress.ip_network(network)
    for network in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
)
# A full stop after the address ends a sentence; one followed by a digit makes a longer dotted number.
IP_ADDRESS = re.compile(r"(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?!\d|\.\d)")
PERSONAL_PATH_LABEL = "personal filesystem path"
PATTERNS = (
    ("possible provider key", re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b")),
    ("possible GitHub token", re.compile(r"\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}\b")),
    ("possible Hugging Face token", re.compile(r"\bhf_[A-Za-z0-9]{20,}\b")),
    ("private key", re.compile(r"-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----")),
    (PERSONAL_PATH_LABEL, re.compile(r"/(?:home|Users)/[\w.-]+/")),
)
PRIVATE_ADDRESS_LABEL = "private network address"


def private_file(path: PurePath) -> bool:
    """Whether a path names a local credential file that must never be tracked."""
    name = path.name.lower()
    if name.endswith(".env.example"):
        return False
    return (
        name == ".env"
        or name.startswith(".env.")
        or name.endswith(".env")
        or ".env." in name
        or path.suffix.lower() in {".pem", ".key", ".p12", ".pfx"}
        or any(part.lower() in {"secrets", "credentials"} for part in path.parts)
    )


def _has_private_address(line: str) -> bool:
    for match in IP_ADDRESS.finditer(line):
        try:
            address = ipaddress.ip_address(match.group())
        except ValueError:
            continue
        if any(address in network for network in PRIVATE_NETWORKS):
            return True
    return False


def _without_controls(line: str) -> str:
    return "".join(char for char in line if char == "\t" or unicodedata.category(char) != "Cc")


def line_problems(line: str) -> list[str]:
    """Labels of the patterns a line matches, never the matched text itself.

    Control characters other than tab are removed first: the bot removes them before posting, so a key split by
    one would otherwise be posted whole.
    """
    line = _without_controls(line)
    problems = [label for label, pattern in PATTERNS if pattern.search(line)]
    if _has_private_address(line):
        problems.append(PRIVATE_ADDRESS_LABEL)
    return problems


def text_problems(text: str, limit: int | None = None) -> list[tuple[int, str]]:
    """The line number (from 1) and label of every problem in every line of a text, or of the first `limit`.

    Lines end only at a newline: `str.splitlines` would also end one at control characters that the bot removes
    before posting, which joins what they separated.
    """
    found = (
        (number, label)
        for number, line in enumerate(text.split("\n"), 1)
        for label in line_problems(line)
    )
    return list(itertools.islice(found, limit))

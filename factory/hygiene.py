"""Patterns for credentials, personal paths and private addresses, shared by the repository checker and the dispatcher.

It also holds the rule for commit messages that the dispatcher and the finish check both apply.
"""

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
    # a home directory as POSIX writes it, or as Windows does: a drive letter, `\Users\`, a name and a backslash
    (PERSONAL_PATH_LABEL, re.compile(r"/(?:home|Users)/[\w.-]+/|[A-Za-z]:\\(?i:users)\\[\w.-]+\\")),
)
PRIVATE_ADDRESS_LABEL = "private network address"
# What GitHub acts on in a commit message once it is pushed, where nothing neutralises it.
MESSAGE_LABELS = (
    "a possible mention (an @ before a letter or digit)",
    "a link to github.com",
    "a reference to an issue other than its own",
)
_MENTION = re.compile(r"@[A-Za-z0-9]")
_GITHUB_LINK = re.compile(r"github\.com/", re.IGNORECASE)
_ISSUE_NUMBER = re.compile(r"#([0-9]+)")  # explicit [0-9]: \d would accept other scripts' digits
# `GH-<n>` names an issue too, and `owner/repo#<n>` one in another repository even when the number is the job's own
_OTHER_REFERENCE = re.compile(r"GH-[0-9]|[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#[0-9]", re.IGNORECASE)
_SEPARATORS = "  "  # the bot removes the line and paragraph separators before posting, as it removes controls


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
    return "".join(char for char in line
                   if char == "\t" or (unicodedata.category(char) != "Cc" and char not in _SEPARATORS))


def line_problems(line: str) -> list[str]:
    """Labels of the patterns a line matches, never the matched text itself.

    Control characters other than tab, and the line and paragraph separators, are removed first: the bot removes
    them before posting, so a key split by one would otherwise be posted whole.
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


def message_problems(message: str, own_issue: int | None) -> list[str]:
    """The labels of MESSAGE_LABELS that a commit message holds, in that order; never the text that matched.

    A commit message reaches GitHub as it is written when the commit is pushed, and GitHub then notifies whoever it
    mentions and links, closes or references whatever issue it names. So a message may name no person, link no page
    on GitHub, and refer to no issue but `own_issue`, written `#<own_issue>`; with `own_issue` None, to none at all.
    """
    others = _OTHER_REFERENCE.search(message) is not None or any(
        match.group(1) != str(own_issue) for match in _ISSUE_NUMBER.finditer(message))
    found = (_MENTION.search(message) is not None, _GITHUB_LINK.search(message) is not None, others)
    return [label for label, holds in zip(MESSAGE_LABELS, found) if holds]

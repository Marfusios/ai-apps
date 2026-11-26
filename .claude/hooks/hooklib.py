"""Shared plumbing for the Claude Code hooks: read the event from stdin and print a decision."""

import json
import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

ACTIONS = ("allow", "ask", "deny")


@dataclass(frozen=True)
class Decision:
    action: str
    reason: str = ""

    def __post_init__(self) -> None:
        if self.action not in ACTIONS:
            raise ValueError(f"action must be one of {ACTIONS}, not {self.action!r}")


def read_input() -> dict:
    """The hook event Claude Code sends on stdin, or {} when it is empty or not a JSON object."""
    try:
        data = json.loads(sys.stdin.buffer.read())
    except (OSError, ValueError, RecursionError):
        return {}
    return data if isinstance(data, dict) else {}


def emit(decision: Decision, event: str = "PreToolUse") -> NoReturn:
    """Print the decision for Claude Code and exit; allowing prints nothing."""
    if decision.action != "allow":
        output = {"permissionDecision": decision.action, "permissionDecisionReason": decision.reason}
        print(json.dumps({"hookSpecificOutput": {"hookEventName": event, **output}}))
    sys.exit(0)


def is_factory_run(env: Mapping[str, str] = os.environ) -> bool:
    """True when the factory started this session, rather than a person."""
    return env.get("FACTORY_RUN") == "1"


def project_dir(data: dict) -> Path:
    """The project root: CLAUDE_PROJECT_DIR, else the event's working directory, else the current one."""
    for candidate in (os.environ.get("CLAUDE_PROJECT_DIR"), data.get("cwd")):
        if isinstance(candidate, str) and candidate:
            return Path(candidate)
    return Path.cwd()

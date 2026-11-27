"""The Podman and Claude command lines of a run, and a reader for the Claude CLI's transcript."""

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

TOKEN_VARIABLE = "CLAUDE_CODE_OAUTH_TOKEN"
CONTAINER_UID = "uid=1000,gid=1000"
BUNDLE_PATH = "/factory/out/commits.bundle"
JOB_DIR = "/factory/job"
RESULT_PATH = "/factory/out/result.json"
# The factory variables that are the same in every run; the image's managed settings fix them too.
FACTORY_ENV = {"FACTORY_RUN": "1", "FACTORY_JOB_DIR": JOB_DIR, "FACTORY_RESULT_PATH": RESULT_PATH}


@dataclass(frozen=True)
class Mounts:
    checkout: Path
    job: Path
    out: Path


@dataclass(frozen=True)
class Facts:
    limited: bool
    resets_at: int | None
    subtype: str
    turns: int | None
    model: str
    started: bool  # an init line was seen: the CLI ran, whether or not it named a model


def claude_argv(request: Mapping) -> list[str]:
    return [
        "claude", "-p", "/" + request["skill"], "--permission-mode", request["permission_mode"],
        "--model", request["model"], "--max-turns", str(request["max_turns"]),
        "--output-format", "stream-json", "--verbose",
    ]


def _confined_run(name: str, network: str) -> list[str]:
    return [
        "podman", "run", "--rm", "--pull=never", "--name", name, "--log-driver=none",
        f"--userns=keep-id:{CONTAINER_UID}", "--cap-drop=all", "--security-opt=no-new-privileges",
        f"--network={network}",
    ]


def agent_argv(request: Mapping, mounts: Mounts, image: str, name: str) -> list[str]:
    """The agent container. The token is named, not given: Podman copies its value from the runner's environment."""
    values = (
        ("FACTORY_RUN", FACTORY_ENV["FACTORY_RUN"]), ("FACTORY_STAGE", request["stage"]),
        ("FACTORY_JOB_DIR", FACTORY_ENV["FACTORY_JOB_DIR"]), ("FACTORY_RESULT_PATH", FACTORY_ENV["FACTORY_RESULT_PATH"]),
        ("FACTORY_BASE_SHA", request["base_sha"]), ("DISABLE_AUTOUPDATER", "1"),
    )
    argv = _confined_run(name, "slirp4netns") + [
        "-v", f"{mounts.checkout}:/workspace:rw", "-v", f"{mounts.job}:{JOB_DIR}:ro",
        "-v", f"{mounts.out}:/factory/out:rw", "-w", "/workspace",
    ]
    for variable, value in values:
        argv += ["--env", f"{variable}={value}"]
    return argv + ["--env", TOKEN_VARIABLE, image, *claude_argv(request)]


def bundle_argv(request: Mapping, mounts: Mounts, image: str, name: str) -> list[str]:
    """Bundle the agent's commits inside a container with no network and no token: the checkout is hostile data.

    The checkout is mounted read-only, because making a bundle does not write to it.
    """
    return _confined_run(name, "none") + [
        "-v", f"{mounts.checkout}:/workspace:ro", "-v", f"{mounts.out}:/factory/out:rw", "-w", "/workspace",
        image, "git", "-C", "/workspace", "bundle", "create", BUNDLE_PATH,
        f"{request['base_sha']}..refs/heads/{request['branch']}",
    ]


def _integer(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def read_transcript(lines: Iterable[str]) -> Facts:
    """What a run's stream of JSON lines says about limits, the final result and the model; junk lines are skipped."""
    limited, resets_at, subtype, turns, model, started = False, None, "", None, "", False
    for line in lines:
        try:
            event = json.loads(line)
        except (ValueError, RecursionError):
            continue
        if not isinstance(event, dict):
            continue
        kind = event.get("type")
        if kind == "rate_limit_event":
            info = event.get("rate_limit_info")
            if isinstance(info, dict) and info.get("status") == "rejected":
                limited, resets_at = True, _integer(info.get("resetsAt"))
        elif kind == "result":
            subtype, turns = _text(event.get("subtype")), _integer(event.get("num_turns"))
        elif kind == "system" and event.get("subtype") == "init":
            model, started = _text(event.get("model")), True
    return Facts(limited, resets_at, subtype, turns, model, started)

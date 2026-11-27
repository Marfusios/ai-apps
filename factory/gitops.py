"""The dispatcher's own git: a mirror of GitHub, a work repository that borrows its objects, and pushes."""

import base64
import os
import re
import subprocess
from pathlib import Path

WORK_BRANCH = re.compile(r"factory/[a-z0-9][a-z0-9-]{0,60}")
SHA = re.compile(r"[0-9a-f]{40}")
TIMEOUT_SECONDS = 300
ANSWERED_NO = 1  # the exit status of a yes-or-no git command, such as `merge-base --is-ancestor`, for "no"


class GitError(Exception):
    """A git command failed, timed out, was refused or could not start.

    It names the command and how it ended, never its arguments, output or environment, which can hold a URL, a host
    path or a token.
    """

    def __init__(self, subcommand: str, status: int | str) -> None:
        self.subcommand = subcommand
        self.status = status
        ending = f"exit status {status}" if isinstance(status, int) else status
        super().__init__(f"git {subcommand} failed: {ending}")


def _subcommand(args: tuple[str, ...]) -> str:
    """The git command's name, past the `-c name=value` pairs that may come before it."""
    index = 0
    while index < len(args) and args[index] == "-c":
        index += 2
    return args[index] if index < len(args) else ""


def _environment(token: str | None) -> dict[str, str]:
    """The dispatcher's environment without any git setting it inherited.

    No GIT_ variable, no system or global configuration and no prompt reach git. A token travels only as an HTTP
    header in environment configuration, never on the command line.
    """
    env = {name: value for name, value in os.environ.items() if not name.upper().startswith("GIT_")}
    env.update(GIT_TERMINAL_PROMPT="0", GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull)
    if token is not None:
        credentials = base64.b64encode(f"x-access-token:{token}".encode("utf-8")).decode("ascii")
        env.update(GIT_CONFIG_COUNT="1", GIT_CONFIG_KEY_0="http.extraHeader",
                   GIT_CONFIG_VALUE_0=f"Authorization: Basic {credentials}")
    return env


def run_git(
    repo: Path | None, *args: str, token: str | None = None, input: bytes | None = None,
    timeout: int = TIMEOUT_SECONDS,
) -> bytes:
    """Run git on `repo` (passed as --git-dir, so git never looks for a repository) and return its output."""
    argv = ["git", *([f"--git-dir={repo}"] if repo is not None else []), *args]
    subcommand = _subcommand(args)
    try:
        done = subprocess.run(
            argv, input=input, stdin=subprocess.DEVNULL if input is None else None, capture_output=True,
            env=_environment(token), timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired:
        raise GitError(subcommand, "timeout") from None
    except OSError as error:
        raise GitError(subcommand, type(error).__name__) from None
    if done.returncode != 0:
        raise GitError(subcommand, done.returncode)
    return done.stdout


def _ensure_bare(repo: Path) -> None:
    if not (repo / "HEAD").is_file():
        run_git(repo, "init", "--bare", "--quiet")


def ensure_mirror(mirror: Path, url: str, token: str) -> None:
    """Create the mirror when it is missing and bring every branch up to date with `url`."""
    _ensure_bare(mirror)
    run_git(mirror, "symbolic-ref", "HEAD", "refs/heads/main")
    run_git(mirror, "fetch", "--prune", "--", url, "+refs/heads/*:refs/heads/*", token=token)


def ensure_workrepo(workrepo: Path, mirror: Path) -> None:
    """Create the bare repository that bundles are fetched into; it reads the mirror's objects, not its refs."""
    _ensure_bare(workrepo)
    alternates = workrepo / "objects" / "info" / "alternates"
    # newline="\n": git would read a Windows line ending as part of the path
    alternates.write_text((mirror / "objects").absolute().as_posix() + "\n", encoding="utf-8", newline="\n")


def resolve(repo: Path, ref: str) -> str | None:
    """The commit a ref names, or None when it names none."""
    try:
        output = run_git(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", f"{ref}^{{commit}}")
    except GitError as error:
        if error.status == ANSWERED_NO:
            return None
        raise
    return output.decode("ascii").strip()


def push(workrepo: Path, url: str, token: str, sha: str, branch: str) -> None:
    """Point a factory branch at `sha`. Only a fast-forward can succeed: there is no force flag and no `+`."""
    is_factory_branch = isinstance(branch, str) and WORK_BRANCH.fullmatch(branch)
    is_commit = isinstance(sha, str) and SHA.fullmatch(sha)
    if not (is_factory_branch and is_commit):
        raise GitError("push", "refused: only a commit pushed to a factory branch is allowed")
    run_git(workrepo, "push", "--", url, f"{sha}:refs/heads/{branch}", token=token)

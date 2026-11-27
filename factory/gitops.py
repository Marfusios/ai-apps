"""The dispatcher's own git: a mirror of GitHub, a work repository that borrows its objects, and pushes.

Every git command runs isolated from inherited settings, under a timeout, with its standard error discarded, and
with its output read as it comes so that a caller can cap it.
"""

import base64
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import BinaryIO

WORK_BRANCH = re.compile(r"factory/[a-z0-9][a-z0-9-]{0,60}")
SHA = re.compile(r"[0-9a-f]{40}")
TIMEOUT_SECONDS = 300
ANSWERED_NO = 1  # the exit status of a yes-or-no git command, such as `merge-base --is-ancestor`, for "no"
CHUNK = 65536


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


class GitOutputTooLarge(GitError):
    """A git command printed more than its caller allowed, and was stopped there."""

    def __init__(self, subcommand: str, limit: int) -> None:
        super().__init__(subcommand, f"more than {limit} bytes of output")


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


def _read(stream: BinaryIO, limit: int | None) -> bytes | None:
    """Everything the stream holds, or None as soon as it has given more than `limit` bytes."""
    chunks, size = [], 0
    while chunk := stream.read(CHUNK):
        size += len(chunk)
        if limit is not None and size > limit:
            return None
        chunks.append(chunk)
    return b"".join(chunks)


def _feed(pipe: BinaryIO, data: bytes) -> None:
    """Write git's input from a thread of its own, so a git that prints while it reads never waits on us."""
    try:
        with pipe:
            pipe.write(data)
    except OSError:
        pass  # git stopped reading: it finished early, failed or was stopped, and its exit status says which


def _stop(process: subprocess.Popen, expired: threading.Event) -> None:
    expired.set()
    process.kill()


def _run(argv: list[str], env: dict[str, str], input: bytes | None, timeout: int,
         limit: int | None) -> tuple[int, bytes | None]:
    """Run git and return its exit status and output; the output is None when git printed more than `limit`."""
    expired = threading.Event()
    with subprocess.Popen(argv, stdin=subprocess.DEVNULL if input is None else subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env) as process:
        timer = threading.Timer(timeout, _stop, (process, expired))
        feeder = None if input is None else threading.Thread(target=_feed, args=(process.stdin, input))
        timer.start()
        try:
            if feeder is not None:
                feeder.start()
            output = _read(process.stdout, limit)
            if output is None:
                process.kill()
            process.wait()
        finally:
            timer.cancel()
            if process.poll() is None:  # reading failed: stop git so that the feeder cannot block on it
                process.kill()
            if feeder is not None:
                feeder.join()
    if expired.is_set():
        raise subprocess.TimeoutExpired(argv, timeout)
    return process.returncode, output


def run_git(
    repo: Path | None, *args: str, token: str | None = None, input: bytes | None = None,
    timeout: int = TIMEOUT_SECONDS, max_output: int | None = None,
) -> bytes:
    """Run git on `repo` and return its standard output.

    `repo` is passed as --git-dir, so git never looks for a repository. Standard error is discarded, since nothing
    of it may reach an error message. With `max_output`, git is stopped as soon as it prints more than that many
    bytes, and GitOutputTooLarge is raised, so a caller can bound what a hostile repository makes it hold.
    """
    argv = ["git", *([f"--git-dir={repo}"] if repo is not None else []), *args]
    subcommand = _subcommand(args)
    try:
        status, output = _run(argv, _environment(token), input, timeout, max_output)
    except subprocess.TimeoutExpired:
        raise GitError(subcommand, "timeout") from None
    except OSError as error:
        raise GitError(subcommand, type(error).__name__) from None
    if output is None:
        raise GitOutputTooLarge(subcommand, max_output)
    if status != 0:
        raise GitError(subcommand, status)
    return output


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

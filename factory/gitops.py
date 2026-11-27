"""The dispatcher's own git: a mirror of GitHub, a work repository that borrows its objects, and pushes.

Every git command runs isolated from inherited settings and without background maintenance, under a timeout that
holds even when a child of git keeps its pipes open, with its standard error discarded, and with its output read
as it comes so that a caller can cap it.
"""

import base64
import contextlib
import os
import re
import signal
import subprocess
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import BinaryIO

WORK_BRANCH = re.compile(r"factory/[a-z0-9][a-z0-9-]{0,60}")
SHA = re.compile(r"[0-9a-f]{40}")
TIMEOUT_SECONDS = 300
LINGER_SECONDS = 2  # how long the threads of a stopped git may take to end before they are abandoned
ANSWERED_NO = 1  # the exit status of a yes-or-no git command, such as `merge-base --is-ancestor`, for "no"
CHUNK = 65536
PUSH_OUTPUT_LIMIT = 100_000  # bytes of `git push --porcelain` output that are read, far more than a push prints
# Automatic gc and maintenance would start a git that outlives the call and holds its pipes.
NO_MAINTENANCE = ("-c", "gc.auto=0", "-c", "maintenance.auto=false")


class GitError(Exception):
    """A git command failed, timed out, was refused or could not start.

    It names the command and how it ended, never its arguments, output or environment, which can hold a URL, a host
    path or a token. `ending` is git's exit status, or the words for how it ended otherwise; `status` is the exit
    status, None when git did not exit on its own (a timeout, too much output) or never ran.
    """

    def __init__(self, subcommand: str, ending: int | str) -> None:
        self.subcommand = subcommand
        self.status: int | None = ending if isinstance(ending, int) else None
        super().__init__(f"git {subcommand} failed: {f'exit status {ending}' if isinstance(ending, int) else ending}")


class PushRefused(GitError):
    """A push failed because the remote, or git, rejected the ref; a failure in transit is a plain GitError."""


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


class _Output:
    """Git's standard output, collected up to a limit by a thread that alone reads and closes the pipe."""

    def __init__(self, stream: BinaryIO, limit: int | None) -> None:
        self._stream = stream
        self._limit = limit
        self._chunks: list[bytes] = []
        self._size = 0
        self.too_large = False
        self.broken = False

    def collect(self) -> None:
        try:
            while chunk := self._stream.read(CHUNK):
                self._size += len(chunk)
                if self._limit is not None and self._size > self._limit:
                    self.too_large = True
                    return
                self._chunks.append(chunk)
        except OSError:
            self.broken = True
        finally:
            # Closing our end breaks git's: a git that cannot be killed, such as the real git behind Git for
            # Windows' launcher, then fails on its next write instead of filling the pipe and waiting forever.
            self._stream.close()

    @property
    def data(self) -> bytes:
        return b"".join(self._chunks)


def _feed(stream: BinaryIO, data: bytes) -> None:
    """Write git's input, then close it so that git sees its end; the thread doing this alone closes the pipe."""
    view = memoryview(data)
    try:
        while view:
            view = view[stream.write(view):]
    except OSError:
        pass  # git stopped reading: it finished early, failed or was stopped, and its exit status says which
    finally:
        stream.close()


def _start(target: Callable[..., None], *args: object) -> threading.Thread:
    thread = threading.Thread(target=target, args=args, daemon=True)  # a stuck one must not keep the program up
    thread.start()
    return thread


def _exits_by(process: subprocess.Popen, deadline: float) -> bool:
    try:
        process.wait(max(deadline - time.monotonic(), 0))
    except subprocess.TimeoutExpired:
        return False
    return True


def _kill(process: subprocess.Popen) -> None:
    """Kill git and, on POSIX, every process in its session, since a child of git can hold its pipes open."""
    if os.name == "posix":
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    else:
        process.kill()


def _run(argv: list[str], env: dict[str, str], input: bytes | None, timeout: int,
         limit: int | None) -> tuple[int, bytes | None]:
    """Run git and return its exit status and output; the output is None when git printed more than `limit`.

    Threads read git's output and write its input, each the only user of its pipe. On an overflow or at the
    timeout git is killed, and the threads then have LINGER_SECONDS to end before they are abandoned, so a
    descendant of git that keeps a pipe open cannot keep the call waiting.
    """
    deadline = time.monotonic() + timeout
    with subprocess.Popen(argv, bufsize=0, stdin=subprocess.DEVNULL if input is None else subprocess.PIPE,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env,
                          start_new_session=os.name == "posix") as process:
        output = _Output(process.stdout, limit)
        threads = [_start(output.collect)]
        if input is not None:
            threads.append(_start(_feed, process.stdin, input))
        process.stdout = process.stdin = None  # the threads close these; Popen must not close them under the threads
        threads[0].join(timeout)
        exited = not threads[0].is_alive() and not output.too_large and _exits_by(process, deadline)
        if not exited:
            _kill(process)
        linger = time.monotonic() + LINGER_SECONDS
        for thread in threads:
            thread.join(max(linger - time.monotonic(), 0))
    if output.too_large:
        return -1, None
    if not exited:
        raise subprocess.TimeoutExpired(argv, timeout)
    if output.broken:
        raise OSError("git's output could not be read")
    return process.returncode, output.data


def run_git_status(
    repo: Path | None, *args: str, token: str | None = None, input: bytes | None = None,
    timeout: int = TIMEOUT_SECONDS, max_output: int | None = None,
) -> tuple[int, bytes]:
    """Run git on `repo` and return its exit status and standard output, whatever the status is.

    `repo` is passed as --git-dir, so git never looks for a repository. Standard error is discarded, since nothing
    of it may reach an error message. With `max_output`, git is stopped as soon as it prints more than that many
    bytes, and GitOutputTooLarge is raised, so a caller can bound what a hostile repository makes it hold. A timeout
    or a git that cannot run raises GitError; a failed command does not, so the caller must look at the status.
    """
    argv = ["git", *([f"--git-dir={repo}"] if repo is not None else []), *NO_MAINTENANCE, *args]
    subcommand = _subcommand(args)
    try:
        status, output = _run(argv, _environment(token), input, timeout, max_output)
    except subprocess.TimeoutExpired:
        raise GitError(subcommand, "timeout") from None
    except OSError as error:
        raise GitError(subcommand, type(error).__name__) from None
    if output is None:
        raise GitOutputTooLarge(subcommand, max_output)
    return status, output


def run_git(
    repo: Path | None, *args: str, token: str | None = None, input: bytes | None = None,
    timeout: int = TIMEOUT_SECONDS, max_output: int | None = None,
) -> bytes:
    """Run git on `repo` and return its standard output; a command that fails raises GitError, which keeps no output."""
    status, output = run_git_status(repo, *args, token=token, input=input, timeout=timeout, max_output=max_output)
    if status != 0:
        raise GitError(_subcommand(args), status)
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
    status, output = run_git_status(workrepo, "push", "--porcelain", "--", url, f"{sha}:refs/heads/{branch}",
                                    token=token, max_output=PUSH_OUTPUT_LIMIT)
    if status == 0:
        return
    # A rejected ref has its own porcelain line, flagged "!". Without one the push failed in transit (a server
    # error, a dropped connection) or at signing in, and trying again can succeed.
    if any(line.startswith("!	") for line in output.decode("utf-8", "replace").splitlines()):
        raise PushRefused("push", status)
    raise GitError("push", status)

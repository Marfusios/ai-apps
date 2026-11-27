"""The runner program: take one job at a time, run the agent in a rootless container and hand back its files.

The runner holds the agent's sign-in token and no GitHub credentials. What the agent writes is hostile data, so
after the agent has run the runner starts nothing from the checkout on the host: the bundle is made by a second
container, and the workspace is removed with Python.
"""

import argparse
import dataclasses
import logging
import os
import re
import signal
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Protocol

try:
    import fcntl
except ImportError:  # not on Windows: there the lock is skipped
    fcntl = None

from factory import jobs, pod
from factory.app_config import AppConfigError
from factory.app_config import load as load_app_config
from factory.bundle_check import MEGABYTE
from factory.config import Config, ConfigError
from factory.config import load as load_config
from factory.image.build import IMAGE_NAME, harness_digest
from factory.result import MAX_RESULT_BYTES
from factory.spool import (JOB_ID, MAX_UNIX_SECONDS, MODEL_NAME, TIME_FORMAT, Spool, SpoolError, read_bounded,
                           validate_run)

log = logging.getLogger("factory.runner")

IMAGE_LABEL = "factory.harness"
CONFINEMENT_TIMEOUT_SECONDS = 3
IDLE_SECONDS = 5.0
SLEEP_SLICE_SECONDS = 1.0
TRANSCRIPT_KEEP_SECONDS = 14 * 24 * 3600
MAX_TRANSCRIPT_LINE = 1_000_000
MAX_JOB_FILE_BYTES = 1_000_000
MAX_STDERR_BYTES = 100_000
# What is kept of the agent container's output: a process in it can write to the CLI's output, which the disk holds.
TRANSCRIPT_CAP = 200_000_000
ERROR_OUTPUT_CAP = 10_000_000
COPY_LINGER_SECONDS = 10
CHUNK = 65536
IMAGE_CHECK_SECONDS = 60
REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
CLONE_SECONDS = 300
GIT_SECONDS = 60
BUNDLE_SECONDS = 600
CLEANUP_SECONDS = 30
HOUSEKEEPING_SECONDS = 3600
KILL_RETRY_SECONDS = 5.0
PODMAN_FAILURES = (125, 126, 127)  # Podman's own statuses: it could not start the container
EMPTY_BUNDLE = "Refusing to create empty bundle"
PRIVATE_MODE = 0o600
DIRECTORY_MODE = 0o700
NO_FACTS = pod.Facts(False, None, "", None, "", False)


class Run(Protocol):
    """Starts a program and returns its exit status; raises `subprocess.TimeoutExpired` when `timeout` passes.

    `stdout` and `stderr` are open binary files, or None to discard the output; `env` None means the runner's own.
    A limit for a stream keeps at most that many of its bytes in the file and reads the rest to its end unkept.
    """

    def __call__(self, argv: Sequence[str], *, env: Mapping[str, str] | None = None, cwd: Path | None = None,
                 stdout: BinaryIO | None = None, stderr: BinaryIO | None = None, timeout: float | None = None,
                 stdout_limit: int | None = None, stderr_limit: int | None = None) -> int: ...


def run_program(argv: Sequence[str], *, env: Mapping[str, str] | None = None, cwd: Path | None = None,
                stdout: BinaryIO | None = None, stderr: BinaryIO | None = None, timeout: float | None = None,
                stdout_limit: int | None = None, stderr_limit: int | None = None) -> int:
    if stdout_limit is None and stderr_limit is None:
        return subprocess.run(list(argv), env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                              stdout=stdout or subprocess.DEVNULL, stderr=stderr or subprocess.DEVNULL,
                              timeout=timeout, check=False).returncode
    return _run_capped(list(argv), env, cwd, ((stdout, stdout_limit), (stderr, stderr_limit)), timeout)


def _run_capped(argv: list[str], env: Mapping[str, str] | None, cwd: Path | None,
                streams: tuple[tuple[BinaryIO | None, int | None], ...], timeout: float | None) -> int:
    """Run a program whose capped streams go through pipes that a thread each copies into the files.

    A thread reads its pipe to the end whatever it keeps, so the program never waits on a full pipe. Once the
    program has ended the threads have COPY_LINGER_SECONDS to finish: a child that kept a pipe open cannot keep the
    runner waiting, and what it writes later is not kept.
    """
    def target(output: BinaryIO | None, limit: int | None) -> object:
        return subprocess.PIPE if limit is not None else (output or subprocess.DEVNULL)

    (stdout, stdout_limit), (stderr, stderr_limit) = streams
    with subprocess.Popen(argv, env=env, cwd=cwd, stdin=subprocess.DEVNULL, stdout=target(stdout, stdout_limit),
                          stderr=target(stderr, stderr_limit)) as process:
        copies = []
        for pipe, (output, limit) in zip((process.stdout, process.stderr), streams):
            if limit is not None:
                copies.append(threading.Thread(target=_copy_capped, args=(pipe, output, limit), daemon=True))
                copies[-1].start()
        process.stdout = process.stderr = None  # the threads close these; Popen must not close them under the threads
        try:
            status = process.wait(timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise
        finally:
            linger = time.monotonic() + COPY_LINGER_SECONDS
            for copy in copies:
                copy.join(max(linger - time.monotonic(), 0))
    return status


def _copy_capped(source: BinaryIO, output: BinaryIO | None, limit: int) -> None:
    """Copy at most `limit` bytes of the pipe into the file, and read the rest to its end without keeping it."""
    kept = 0
    try:
        while chunk := source.read(CHUNK):
            if output is not None and kept < limit:
                part = chunk[:limit - kept]
                kept += len(part)
                try:
                    output.write(part)
                except (OSError, ValueError):  # a full disk, or a file already closed: the rest is read, not kept
                    kept = limit
    except OSError:
        pass  # the program's end of the pipe broke; its exit status says how it ended
    finally:
        source.close()


class SettingsError(ValueError):
    """The environment lacks a setting or holds a malformed one; the message names variables, never their values."""


@dataclass(frozen=True)
class Settings:
    spool_dir: Path
    mirror_dir: Path
    work_dir: Path
    image: str

    @property
    def mirror(self) -> Path:
        return self.mirror_dir / "repo.git"


def settings_from_env(env: Mapping[str, str]) -> Settings:
    """Read every setting, or raise a SettingsError naming each variable that is missing or malformed.

    The sign-in token must be set, but its value is never read into the settings.
    """
    problems: list[str] = []

    def directory(name: str) -> str:
        value = env.get(name, "")
        if not value:
            problems.append(f"{name} is missing")
        elif not Path(value).is_absolute():
            problems.append(f"{name} must be an absolute path")
        elif re.search("[:,]", value[len(Path(value).drive):]):
            problems.append(f"{name} must not contain a colon or a comma")  # Podman reads them in -v
        else:
            return value
        return ""

    spool_dir, mirror_dir, work_dir = (directory(name) for name in
                                       ("FACTORY_SPOOL_DIR", "FACTORY_MIRROR_DIR", "FACTORY_WORK_DIR"))
    image = env.get("FACTORY_IMAGE", "")
    if not image:
        problems.append("FACTORY_IMAGE is missing")
    elif IMAGE_NAME.fullmatch(image) is None:
        problems.append("FACTORY_IMAGE is malformed")
    if not env.get(pod.TOKEN_VARIABLE):
        problems.append(f"{pod.TOKEN_VARIABLE} is missing")
    if problems:
        raise SettingsError("; ".join(problems))
    return Settings(Path(spool_dir), Path(mirror_dir), Path(work_dir), image)


def confined() -> bool:
    """True when the host refuses this user a connection to the loopback address, as its firewall rule should.

    A listener is opened on the loopback address and this same process connects to it. The address is built here
    so that no literal is committed.
    """
    address = socket.inet_ntoa(struct.pack("!I", socket.INADDR_LOOPBACK))
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind((address, 0))
        listener.listen(1)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
            client.settimeout(CONFINEMENT_TIMEOUT_SECONDS)
            try:
                client.connect((address, listener.getsockname()[1]))
            except OSError:
                return True
    return False


def _is_real_directory(info: os.stat_result) -> bool:
    reparse = getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return stat.S_ISDIR(info.st_mode) and not reparse


DESCRIPTOR_WALK = (
    hasattr(os, "O_DIRECTORY") and hasattr(os, "O_NOFOLLOW") and hasattr(os, "fchmod")
    and {os.open, os.stat, os.chmod, os.unlink, os.rmdir} <= os.supports_dir_fd and os.scandir in os.supports_fd
)
OPEN_DIRECTORIES = 32  # descriptors the walk holds below the root, however deep the tree


def remove_tree(path: Path) -> bool:
    """Remove a tree an agent has written in; return whether it is gone. It never raises and never follows a link.

    A real directory is made writable (`0o700`), emptied and removed; anything else, a link included, is unlinked
    without being followed. No other mode is changed, except that a read-only regular file (git leaves them) is
    made writable where the platform refuses to delete it otherwise. An error does not stop the walk.

    Where the platform has directory descriptors the walk uses them, so that no path is resolved by name below
    the top and a tree nested deeper than the path limit is still removed; elsewhere it walks by path.
    """
    try:
        if DESCRIPTOR_WALK:
            _remove_by_descriptors(os.fspath(path))
        else:
            _remove_by_path(os.fspath(path))
    except OSError:
        pass
    return not os.path.lexists(path)


def _remove_by_path(path: str) -> None:
    stack: list[tuple[str, bool]] = [(path, False)]
    while stack:
        current, emptied = stack.pop()
        try:
            if emptied:
                os.rmdir(current)
                continue
            info = os.lstat(current)
            if not _is_real_directory(info):
                _unlink(current, info)
                continue
            os.chmod(current, stat.S_IRWXU)
            names = os.listdir(current)
        except FileNotFoundError:
            continue
        except OSError:
            continue
        stack.append((current, True))
        stack.extend((os.path.join(current, name), False) for name in names)


def _remove_by_descriptors(path: str) -> None:
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return
    if not _is_real_directory(info):
        _unlink(path, info)
        return
    try:
        root = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except PermissionError:
        os.chmod(path, stat.S_IRWXU)
        root = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        _DescriptorWalk(root).run()
    finally:
        os.close(root)
    os.rmdir(path)


def _open_directory(parent: int, name: str) -> int:
    """Open a subdirectory of an open directory without following a link; unlock it first if it is not readable."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    try:
        return os.open(name, flags, dir_fd=parent)
    except PermissionError:
        if not stat.S_ISDIR(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode):
            raise
        os.chmod(name, stat.S_IRWXU, dir_fd=parent)
        return os.open(name, flags, dir_fd=parent)


def _empty_directory(directory: int) -> list[str]:
    """Make an open directory writable and delete what it holds but its subdirectories, whose names it returns."""
    subdirectories = []
    try:
        os.fchmod(directory, stat.S_IRWXU)
        with os.scandir(directory) as entries:
            found = [(entry.name, entry.is_dir(follow_symlinks=False)) for entry in entries]
    except OSError:
        return []
    for name, is_directory in found:
        if is_directory:
            subdirectories.append(name)
            continue
        try:
            os.unlink(name, dir_fd=directory)
        except OSError:
            pass  # the entry stays, the directory cannot then be removed, and the caller sees that
    return subdirectories


def _identity(descriptor: int) -> tuple[int, int] | None:
    """The device and inode of an open directory, or None when they cannot be read."""
    try:
        info = os.fstat(descriptor)
    except OSError:
        return None
    return info.st_dev, info.st_ino


class _DescriptorWalk:
    """Empty and remove everything below an open directory while holding a bounded number of descriptors.

    The chain of directories being emptied is kept as names, with the identity each had when it was opened; a
    descriptor is held for each of the deepest OPEN_DIRECTORIES of them only. When the walk climbs above those it
    opens `..` from the directory it leaves and keeps it when it is the directory the walk came through; only when
    it is not, because something moved, is the chain opened again from the root, one name at a time. So a tree
    thousands of levels deep never needs thousands of descriptors, and each level is opened about twice.
    """

    def __init__(self, root: int) -> None:
        self._root = root
        self._names: list[str] = []  # the directories being emptied, from the one below the root down
        self._identities: list[tuple[int, int] | None] = []  # of each of those, as it was opened
        self._pending: list[list[str]] = []  # per level, root first: subdirectories not visited yet
        self._held: list[int] = []  # descriptors of the deepest directories of the chain, the deepest last

    def run(self) -> None:
        try:
            self._pending.append(_empty_directory(self._root))
            while self._pending:
                if self._pending[-1]:
                    self._descend(self._pending[-1].pop())
                    continue
                self._pending.pop()
                if self._names:
                    self._remove_deepest()
        finally:
            for descriptor in self._held:
                os.close(descriptor)

    def _current(self) -> int:
        """The descriptor of the deepest directory of the chain, opened again if the walk had let it go."""
        if not self._names:
            return self._root
        if not self._held:
            self._reopen()
        return self._held[-1]

    def _reopen(self) -> None:
        held: list[int] = []
        try:
            parent = self._root
            for name in self._names:
                parent = _open_directory(parent, name)
                held.append(parent)
                if len(held) > OPEN_DIRECTORIES:
                    os.close(held.pop(0))
        except BaseException:
            for descriptor in held:
                os.close(descriptor)
            raise
        self._held = held

    def _descend(self, name: str) -> None:
        parent = self._current()
        try:
            descriptor = _open_directory(parent, name)
        except OSError:
            # gone, or no longer a real directory: whatever the name is now is unlinked, never followed
            try:
                os.unlink(name, dir_fd=parent)
            except OSError:
                pass
            return
        self._names.append(name)
        self._identities.append(_identity(descriptor))
        self._held.append(descriptor)
        if len(self._held) > OPEN_DIRECTORIES:
            os.close(self._held.pop(0))
        self._pending.append(_empty_directory(descriptor))

    def _remove_deepest(self) -> None:
        name = self._names.pop()
        self._identities.pop()
        deepest = self._held.pop()
        try:
            if self._names and not self._held:
                self._climb(deepest)
        finally:
            os.close(deepest)
        try:
            os.rmdir(name, dir_fd=self._current())
        except OSError:
            pass

    def _climb(self, child: int) -> None:
        """Hold the directory above `child` again, by its `..` when that is the one the walk came through."""
        try:
            parent = os.open("..", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=child)
        except OSError:
            self._reopen()
            return
        recorded = self._identities[-1]
        if recorded is not None and _identity(parent) == recorded:
            self._held = [parent]
        else:  # moved, or unknown: the chain is opened again by its names from the root
            os.close(parent)
            self._reopen()


def _unlink(path: str, info: os.stat_result) -> None:
    try:
        os.unlink(path)
    except PermissionError:
        if not stat.S_ISREG(info.st_mode):
            raise
        os.chmod(path, stat.S_IWRITE | stat.S_IREAD)
        os.unlink(path)


def transcript_lines(path: Path) -> Iterator[str]:
    """The lines of a transcript, one at a time; a line over the limit is skipped without being held in memory."""
    with open(path, encoding="utf-8", errors="replace") as stream:
        while True:
            line = stream.readline(MAX_TRANSCRIPT_LINE + 2)
            if not line:
                return
            complete = line.endswith("\n")
            if not complete and len(line) == MAX_TRANSCRIPT_LINE + 2:
                rest = stream.readline(MAX_TRANSCRIPT_LINE)
                while rest and not rest.endswith("\n"):
                    rest = stream.readline(MAX_TRANSCRIPT_LINE)
                continue
            content = line[:-1] if complete else line
            if len(content) <= MAX_TRANSCRIPT_LINE:
                yield content


@dataclass(frozen=True)
class Outcome:
    status: str
    reason: str | None = None
    facts: pod.Facts = NO_FACTS
    files: Mapping[str, Path] = field(default_factory=dict)


CRASHED = Outcome("crashed", "internal")


class AlreadyRunning(Exception):
    """Another runner holds the lock on the work directory."""


def acquire_lock(work_dir: Path) -> BinaryIO | None:
    """Take the exclusive lock that keeps a second runner from touching a live job; None where there is no flock.

    The lock lasts as long as the returned file stays open. Only contention means another runner holds it: any
    other OSError, from creating or locking the file, is raised as it is.
    """
    if fcntl is None:
        return None
    work_dir.mkdir(mode=DIRECTORY_MODE, parents=True, exist_ok=True)
    handle = open(work_dir / "runner.lock", "ab")
    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        handle.close()
        raise AlreadyRunning from None
    except BaseException:
        handle.close()
        raise
    return handle


class Runner:
    """Handles queued jobs one at a time and always leaves exactly one `run.json` for each job it claims."""

    def __init__(
        self,
        settings: Settings,
        config: Config,
        spool: Spool,
        *,
        run: Run = run_program,
        clock: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        confined: Callable[[], bool] = confined,
        digest: Callable[[], str] | None = None,
    ) -> None:
        self._settings = settings
        self._config = config
        self._spool = spool
        self._run = run
        self._clock = clock
        self._confined = confined
        self._digest = digest
        self._stopping = False
        self._container: str | None = None  # the container that is running now, the agent's or the bundler's
        self._deadline = 0.0  # when the stage that runs it must be over, on the monotonic clock
        self._unremoved: set[str] = set()  # jobs whose containers could not be removed
        self._last_housekeeping = clock()

    @property
    def _work(self) -> Path:
        return self._settings.work_dir

    def is_confined(self) -> bool:
        return self._confined()

    def image_ok(self) -> bool:
        """True when the image exists and, if a digest is known, carries a label that equals it."""
        self._work.mkdir(mode=DIRECTORY_MODE, parents=True, exist_ok=True)
        argv = ["podman", "image", "inspect", "--format", '{{index .Labels "%s"}}' % IMAGE_LABEL,
                self._settings.image]
        with tempfile.TemporaryFile(dir=self._work) as output:
            try:
                status = self._run(argv, cwd=self._work, stdout=output, timeout=IMAGE_CHECK_SECONDS)
            except (OSError, subprocess.TimeoutExpired):
                return False
            if status != 0:
                return False
            output.seek(0)
            label = output.read(MAX_STDERR_BYTES).decode("utf-8", errors="replace").strip()
        return self._digest is None or label == self._digest()

    def stop(self) -> None:
        """Ask the runner to stop: kill the running container; that job is recorded as an internal crash.

        A kill that fails is repeated in the background every few seconds until the container is gone or the
        stage's time limit ends, so that a stop does not depend on one `podman kill` going through.
        """
        self._stopping = True
        name = self._container
        if name is not None and not self._podman("kill", name):
            threading.Thread(target=self._kill_until_gone, args=(name, self._deadline), daemon=True).start()

    def _kill_until_gone(self, name: str, deadline: float) -> None:
        while self._container == name and time.monotonic() < deadline:
            time.sleep(KILL_RETRY_SECONDS)
            if self._container != name or time.monotonic() >= deadline or self._podman("kill", name):
                return

    def housekeeping(self) -> None:
        """Prune old transcripts and the spool about once an hour; a failure is logged and ignored."""
        now = self._clock()
        if (now - self._last_housekeeping).total_seconds() < HOUSEKEEPING_SECONDS:
            return
        self._last_housekeeping = now
        try:
            self.prune_transcripts()
            self._spool.prune("runner", now)
        except (SpoolError, OSError) as error:
            log.error("housekeeping failed: %s", type(error).__name__)

    def recover(self) -> list[str]:
        """Clear what earlier runs left, then finish every job still `running` as crashed; return those finished.

        With one runner (the lock sees to it) nothing can still be running at start-up, so a container found for
        such a job is an orphan. For each job left running, and each job a workspace is left of, the containers are
        removed, then the workspace: a run that could not remove them left its workspace for here. Only then are
        the records written, so that a full disk is freed first; a record that cannot be written is logged, and the
        next poll writes it (`run_next`).
        """
        running = [job_id for job_id in self._spool.job_ids() if self._spool.state(job_id) == "running"]
        leftovers = dict.fromkeys(running)
        for parent in (self._work, self._work / "staging"):
            for entry in sorted(parent.iterdir()) if parent.is_dir() else ():
                if JOB_ID.fullmatch(entry.name):
                    leftovers[entry.name] = None
        for job_id in leftovers:
            self._remove_containers(job_id)
            self._clean(job_id)
        return [job_id for job_id in running if self._finish_orphan(job_id)]

    def _finish_orphan(self, job_id: str) -> bool:
        """Record a job left `running` by no run of this process as an internal crash; False when it cannot be."""
        now = self._clock()
        try:
            self._spool.finish(job_id, _record(job_id, CRASHED, now, now), {})
        except SpoolError as error:  # the spool's messages name no host path
            log.error("job %s: its crashed record cannot be written: %s", job_id, error)
            return False
        return True

    def prune_transcripts(self) -> list[str]:
        """Delete transcripts older than 14 days; return their file names."""
        directory = self._work / "transcripts"
        if not directory.is_dir():
            return []
        cutoff = self._clock().timestamp() - TRANSCRIPT_KEEP_SECONDS
        removed = []
        for entry in sorted(directory.iterdir()):
            if entry.is_file() and entry.lstat().st_mtime < cutoff:
                entry.unlink()
                removed.append(entry.name)
        return removed

    def run_next(self) -> str | None:
        """Handle the oldest queued job nobody else has claimed; return its id, or None when there was none.

        Once a stop is pending nothing is claimed: a job left queued is picked up by the next start. A job that is
        `running` here, between two jobs of this process that holds the lock, is an orphan whose record could not be
        written before, at start-up or at the end of its run: it is written now.
        """
        if self._stopping:
            return None
        for job_id in self._spool.job_ids():
            state = self._spool.state(job_id)
            if state == "running":
                self._finish_orphan(job_id)
            elif state == "queued" and self._spool.claim(job_id, self._clock()):
                self._handle(job_id)
                return job_id
        return None

    def _handle(self, job_id: str) -> None:
        started = self._clock()
        try:
            try:
                outcome = self._execute(job_id)
            except Exception as error:
                log.error("job %s: unexpected failure: %s", job_id, type(error).__name__)
                outcome = CRASHED
            try:
                self._spool.finish(job_id, _record(job_id, outcome, started, self._clock()), outcome.files)
            except Exception as error:
                log.error("job %s: the run could not be recorded: %s", job_id, type(error).__name__)
                outcome = CRASHED
                self._spool.finish(job_id, _record(job_id, outcome, started, self._clock()), {})
            log.info("job %s: %s", job_id, outcome.status)
        except Exception as error:
            log.error("job %s: no run record could be written: %s", job_id, type(error).__name__)
        finally:
            self._clean(job_id)

    def _clean(self, job_id: str) -> None:
        if job_id in self._unremoved:
            log.error("job %s: its containers could not be removed; its work directories are left for the next start",
                      job_id)
            return
        for path in (self._work / job_id, self._work / "staging" / job_id):
            if not remove_tree(path):
                log.error("job %s: a work directory could not be removed completely", job_id)

    def _execute(self, job_id: str) -> Outcome:
        if not self._confined():
            return Outcome("refused", "firewall")
        request = self._request(job_id)
        if request is None:
            return Outcome("refused", "request")
        if not self.image_ok():
            return Outcome("refused", "image")
        mounts = self._make_workspace(job_id, self._work / job_id)
        if not self._clone(request, mounts.checkout):
            return Outcome("crashed", "clone")
        unsupported = self._unsupported(request, mounts.checkout)
        if unsupported is not None:
            return unsupported
        staging = self._work / "staging" / job_id
        staging.mkdir(mode=DIRECTORY_MODE, parents=True)
        return self._agent(job_id, request, mounts, staging)

    def _request(self, job_id: str) -> dict | None:
        try:
            request = self._spool.request(job_id)
        except SpoolError:
            return None
        if jobs.validate_request(request) or request["job_id"] != job_id:
            return None
        return request

    def _make_workspace(self, job_id: str, workspace: Path) -> pod.Mounts:
        """The agent's directories: the checkout is made by git later, and the request is not copied."""
        job, out = workspace / "job", workspace / "out"
        for directory in (workspace, job, out):
            directory.mkdir(mode=DIRECTORY_MODE, parents=True)
        for name in ("job.json", "context.md"):
            (job / name).write_bytes(read_bounded(self._spool.job_file(job_id, name), MAX_JOB_FILE_BYTES))
        return pod.Mounts(workspace / "checkout", job, out)

    def _clone(self, request: Mapping, checkout: Path) -> bool:
        """Clone the mirror and put the work branch at the base commit, with no configuration of the host's own."""
        mirror = self._settings.mirror
        gitconfig = checkout.parent / "gitconfig"
        gitconfig.write_text(f"[safe]\n\tdirectory = {mirror.as_posix()}\n", encoding="utf-8")
        env = {name: value for name, value in os.environ.items()
               if not name.upper().startswith("GIT_") and name != pod.TOKEN_VARIABLE}
        env.update(GIT_CONFIG_GLOBAL=str(gitconfig), GIT_CONFIG_NOSYSTEM="1", GIT_TERMINAL_PROMPT="0")
        inside = ["git", "-C", str(checkout)]
        steps = (
            (["git", "clone", "--no-checkout", "--no-hardlinks", str(mirror), str(checkout)], CLONE_SECONDS),
            ([*inside, "checkout", "-B", request["branch"], request["base_sha"]], GIT_SECONDS),
            ([*inside, "config", "user.name", request["git_name"]], GIT_SECONDS),
            ([*inside, "config", "user.email", request["git_email"]], GIT_SECONDS),
            ([*inside, "remote", "set-url", "origin", request["repository_url"]], GIT_SECONDS),
        )
        for argv, seconds in steps:
            try:
                if self._run(argv, env=env, cwd=self._work, timeout=seconds) != 0:
                    return False
            except subprocess.TimeoutExpired:
                return False
        return True

    def _unsupported(self, request: Mapping, checkout: Path) -> Outcome | None:
        """A refusal when the app asks for a toolchain the image lacks or for services the runner cannot start."""
        try:
            app = load_app_config(checkout / "apps" / request["app"], self._config.image_registries)
        except AppConfigError:
            return Outcome("refused", "toolchain")
        known = self._config.agent.toolchains
        if any(version not in known.get(name, ()) for name, version in app.toolchain.items()):
            return Outcome("refused", "toolchain")
        if app.services:
            return Outcome("refused", "services")
        return None

    def _agent(self, job_id: str, request: Mapping, mounts: pod.Mounts, staging: Path) -> Outcome:
        name = f"factory-{job_id}"
        transcripts = self._work / "transcripts"
        transcripts.mkdir(mode=DIRECTORY_MODE, parents=True, exist_ok=True)
        transcript, errors = transcripts / f"{job_id}.jsonl", transcripts / f"{job_id}.err"
        argv = pod.agent_argv(request, mounts, self._settings.image, name)
        seconds = request["timeout_minutes"] * 60
        self._container, self._deadline = name, time.monotonic() + seconds
        try:
            if self._stopping:  # a stop that came before the name was recorded found no container to kill
                return CRASHED
            with _private_file(transcript) as stdout, _private_file(errors) as stderr:
                try:
                    status = self._run(argv, cwd=self._work, stdout=stdout, stderr=stderr, timeout=seconds,
                                       stdout_limit=TRANSCRIPT_CAP, stderr_limit=ERROR_OUTPUT_CAP)
                except subprocess.TimeoutExpired:
                    self._remove_containers(job_id, agent_only=True)
                    return Outcome("timeout")
                finally:
                    _log_cut(job_id, "the transcript", stdout, TRANSCRIPT_CAP)
                    _log_cut(job_id, "the error output", stderr, ERROR_OUTPUT_CAP)
        finally:
            self._container = None
        if self._stopping:
            return CRASHED
        facts = pod.read_transcript(transcript_lines(transcript))
        if status in PODMAN_FAILURES and not facts.started:
            return Outcome("crashed", "internal", facts)  # Podman never ran the CLI
        result = _take(mounts.out / "result.json", MAX_RESULT_BYTES, staging / "result.json")
        if facts.limited and result is None:
            return Outcome("usage_limit", facts=facts)
        if facts.subtype == "error_max_turns":
            return Outcome("crashed", "max_turns", facts)
        if result is None:
            return Outcome("crashed", "agent_error", facts)
        files = {"result.json": result}
        bundle = self._bundle(job_id, request, mounts, staging)
        if self._stopping:
            return CRASHED  # a bundle container that was killed leaves no bundle, which is not "no commits"
        if bundle is not None:
            files["commits.bundle"] = bundle
        return Outcome("completed", None, facts, files)

    def _bundle(self, job_id: str, request: Mapping, mounts: pod.Mounts, staging: Path) -> Path | None:
        """Bundle the agent's commits in a container of its own; None when there is no usable bundle.

        The container writes to a fresh directory the agent never saw, so nothing the agent left in `out` can
        interfere. A failure costs only the bundle: the agent's result is still handed over.
        """
        bundle_out = mounts.out.parent / "bundle-out"
        bundle_out.mkdir(mode=DIRECTORY_MODE)
        name = f"factory-{job_id}-bundle"
        argv = pod.bundle_argv(request, dataclasses.replace(mounts, out=bundle_out), self._settings.image, name)
        errors = staging / "bundle.err"
        self._container, self._deadline = name, time.monotonic() + BUNDLE_SECONDS
        try:
            if self._stopping:  # as in the agent's stage; the caller then records the internal crash
                return None
            with _private_file(errors) as stderr:
                try:
                    status = self._run(argv, cwd=self._work, stderr=stderr, timeout=BUNDLE_SECONDS)
                except subprocess.TimeoutExpired:
                    self._remove_containers(job_id, bundle_only=True)
                    log.error("job %s: the bundle container timed out; no bundle is handed over", job_id)
                    return None
        finally:
            self._container = None
        if status != 0:
            try:
                text = read_bounded(errors, MAX_STDERR_BYTES).decode("utf-8", errors="replace")
            except SpoolError:
                text = ""
            if EMPTY_BUNDLE not in text:
                log.error("job %s: the bundle container failed; no bundle is handed over", job_id)
            return None
        limit = self._config.dispatcher.max_bundle_megabytes * MEGABYTE
        return _take(bundle_out / "commits.bundle", limit, staging / "commits.bundle")

    def _podman(self, *arguments: str) -> bool:
        """Best effort: a failure is logged and nothing else. True when Podman exited with status 0."""
        argv = ["podman", *arguments]
        try:
            return self._run(argv, cwd=self._work, timeout=CLEANUP_SECONDS) == 0
        except (OSError, subprocess.TimeoutExpired):
            log.error("%s did not finish", " ".join(argv[:2]))
            return False

    def _remove_containers(self, job_id: str, *, agent_only: bool = False, bundle_only: bool = False) -> None:
        names = [] if bundle_only else [f"factory-{job_id}"]
        names += [] if agent_only else [f"factory-{job_id}-bundle"]
        removed = True
        for name in names:
            if agent_only:
                self._podman("kill", name)
            # --ignore: a container that is already gone (the agent's own is run with --rm) is not a failure
            removed = self._podman("rm", "-f", "--ignore", name) and removed
        if removed:
            self._unremoved.discard(job_id)
        else:
            self._unremoved.add(job_id)


def _private_file(path: Path) -> BinaryIO:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), PRIVATE_MODE)
    return os.fdopen(descriptor, "wb")


def _log_cut(job_id: str, what: str, output: BinaryIO, cap: int) -> None:
    """One log line when an output file holds as much as its cap allows: what came after was not kept.

    It never raises: a file that cannot be flushed or measured, on a full disk, must not change how the run ended.
    """
    try:
        output.flush()
        size = os.fstat(output.fileno()).st_size
    except OSError:
        return
    if size >= cap:
        log.warning("job %s: %s reached its cap of %d bytes; the rest was read and not kept", job_id, what, cap)


def _take(source: Path, limit: int, target: Path) -> Path | None:
    """Copy a file the agent wrote into the runner's own staging area; None when it is missing, odd or too large."""
    try:
        data = read_bounded(source, limit)
    except SpoolError:
        return None
    target.write_bytes(data)
    return target


def _stamp(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime(TIME_FORMAT)


def _record(job_id: str, outcome: Outcome, started: datetime, finished: datetime) -> dict:
    """The `run.json` of a job; whatever the transcript supplied that does not fit is replaced by a safe value."""
    facts = outcome.facts
    record = {
        "schema": 1, "job_id": job_id, "status": outcome.status, "reason": outcome.reason,
        "started_at": _stamp(started), "finished_at": _stamp(finished),
        "duration_seconds": max(0, min(int((finished - started).total_seconds()), 1_000_000)),
        "model": facts.model, "turns": facts.turns,
        "resets_at": facts.resets_at if outcome.status == "usage_limit" else None,
    }
    if not validate_run(record):
        return record
    record.update(
        model=facts.model if MODEL_NAME.fullmatch(facts.model) else "",
        turns=facts.turns if facts.turns is not None and 0 <= facts.turns <= 100_000 else None,
        resets_at=record["resets_at"] if record["resets_at"] is not None
        and 0 <= record["resets_at"] <= MAX_UNIX_SECONDS else None,
    )
    problems = validate_run(record)
    if problems:
        raise ValueError("the run record is invalid: " + "; ".join(problems))
    return record


def check(runner: Runner, spool: Spool) -> tuple[bool, list[str]]:
    """What `--check` prints: one line each for confinement, the image and the spool, and whether all hold."""
    confinement = runner.is_confined()
    image = runner.image_ok()
    try:
        spool.prepare("runner")
        spool_ok, spool_line = True, "spool: ok"
    except SpoolError as error:
        spool_ok, spool_line = False, f"spool: {error}"
    return confinement and image and spool_ok, [
        "confinement: ok" if confinement else "confinement: the host does not refuse a loopback connection",
        "image: ok" if image else "image: missing or not the one the harness describes; "
        "python -m factory.image.build rebuilds it",
        spool_line,
    ]


def _sleep(stop: threading.Event, seconds: float) -> None:
    """Wait in short slices so that a stop signal ends the wait within a second or two, whatever the platform."""
    deadline = time.monotonic() + seconds
    while not stop.is_set():
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return
        stop.wait(min(SLEEP_SLICE_SECONDS, remaining))


def serve(runner: Runner, stop: threading.Event, *, once: bool = False) -> None:
    """Handle jobs until `stop` is set, finishing the current job; with `once`, at most one."""
    while not stop.is_set():
        try:
            handled = runner.run_next()
        except (SpoolError, OSError) as error:
            log.error("the poll failed: %s", type(error).__name__)
            handled = None
        if once:
            return
        runner.housekeeping()
        if handled is None:
            _sleep(stop, IDLE_SECONDS)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="factory.runner", description="Run the factory's queued jobs.")
    parser.add_argument("--once", action="store_true", help="handle at most one job and exit")
    parser.add_argument("--check", action="store_true",
                        help="check confinement, image and spool, and exit; it creates the work directory and a "
                        "temporary file in it, and takes no lock")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = settings_from_env(os.environ)
    except SettingsError as error:
        log.error("settings: %s", error)
        return 2
    try:
        config = load_config()
    except ConfigError as error:  # its message names the file and the key, never a value of the environment
        log.error("configuration: %s", error)
        return 2
    spool = Spool(settings.spool_dir)
    runner = Runner(settings, config, spool, digest=lambda: harness_digest(REPOSITORY_ROOT))
    if args.check:
        healthy, lines = check(runner, spool)
        print("\n".join(lines))
        return 0 if healthy else 1
    try:
        lock = acquire_lock(settings.work_dir)  # held until the process ends
    except AlreadyRunning:
        log.error("another runner holds the lock on the work directory")
        return 1
    except OSError as error:
        log.error("start-up failed: %s", type(error).__name__)
        return 1
    try:
        spool.prepare("runner")
        runner.prune_transcripts()
        recovered = runner.recover()
    except SpoolError as error:  # the spool's messages name no host path, and say what to do
        log.error("start-up failed: %s", error)
        return 1
    except OSError as error:
        log.error("start-up failed: %s", type(error).__name__)
        return 1
    if recovered:
        log.warning("finished %d job(s) left running as crashed", len(recovered))
    stop = threading.Event()

    def request_stop(*_: object) -> None:
        stop.set()
        runner.stop()

    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), request_stop)
    try:
        serve(runner, stop, once=args.once)
    finally:
        if lock is not None:
            lock.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

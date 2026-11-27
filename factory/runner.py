"""The runner program: take one job at a time, run the agent in a rootless container and hand back its files.

The runner holds the agent's sign-in token and no GitHub credentials. What the agent writes is hostile data, so
after the agent has run the runner starts nothing from the checkout on the host: the bundle is made by a second
container, and the workspace is removed with Python.
"""

import argparse
import logging
import os
import re
import shutil
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

from factory import jobs, pod
from factory.app_config import AppConfigError
from factory.app_config import load as load_app_config
from factory.bundle_check import MEGABYTE
from factory.config import Config
from factory.config import load as load_config
from factory.result import MAX_RESULT_BYTES
from factory.spool import MAX_UNIX_SECONDS, MODEL_NAME, TIME_FORMAT, Spool, SpoolError, read_bounded, validate_run

log = logging.getLogger("factory.runner")

IMAGE_LABEL = "factory.harness"
IMAGE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/@-]*")  # never starts with "-", so it is not a Podman option
CONFINEMENT_TIMEOUT_SECONDS = 3
IDLE_SECONDS = 5.0
SLEEP_SLICE_SECONDS = 1.0
TRANSCRIPT_KEEP_SECONDS = 14 * 24 * 3600
MAX_TRANSCRIPT_LINE = 1_000_000
MAX_JOB_FILE_BYTES = 1_000_000
MAX_STDERR_BYTES = 100_000
IMAGE_CHECK_SECONDS = 60
CLONE_SECONDS = 300
GIT_SECONDS = 60
BUNDLE_SECONDS = 600
CLEANUP_SECONDS = 30
EMPTY_BUNDLE = "Refusing to create empty bundle"
PRIVATE_MODE = 0o600
DIRECTORY_MODE = 0o700
NO_FACTS = pod.Facts(False, None, "", None, "")


class Run(Protocol):
    """Starts a program and returns its exit status; raises `subprocess.TimeoutExpired` when `timeout` passes.

    `stdout` and `stderr` are open binary files, or None to discard the output; `env` None means the runner's own.
    """

    def __call__(self, argv: Sequence[str], *, env: Mapping[str, str] | None = None, cwd: Path | None = None,
                 stdout: BinaryIO | None = None, stderr: BinaryIO | None = None,
                 timeout: float | None = None) -> int: ...


def run_program(argv: Sequence[str], *, env: Mapping[str, str] | None = None, cwd: Path | None = None,
                stdout: BinaryIO | None = None, stderr: BinaryIO | None = None, timeout: float | None = None) -> int:
    return subprocess.run(list(argv), env=env, cwd=cwd, stdin=subprocess.DEVNULL,
                          stdout=stdout or subprocess.DEVNULL, stderr=stderr or subprocess.DEVNULL,
                          timeout=timeout, check=False).returncode


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


def _clear_read_only(function: Callable[[str], object], path: str, _error: object) -> None:
    """Make a path and its directory writable and retry: git object files are read-only."""
    for target in (os.path.dirname(path), path):
        try:
            os.chmod(target, stat.S_IRWXU)
        except OSError:
            pass
    function(path)


def remove_tree(path: Path) -> None:
    if not os.path.lexists(path):
        return
    if sys.version_info >= (3, 12):
        shutil.rmtree(path, onexc=_clear_read_only)
    else:
        shutil.rmtree(path, onerror=_clear_read_only)


def transcript_lines(path: Path) -> Iterator[str]:
    """The lines of a transcript, one at a time; a line over the limit is skipped without being held in memory."""
    with open(path, encoding="utf-8", errors="replace") as stream:
        while True:
            line = stream.readline(MAX_TRANSCRIPT_LINE + 2)
            if not line:
                return
            complete = line.endswith("\n")
            if not complete and len(line) == MAX_TRANSCRIPT_LINE + 2:
                while not stream.readline(MAX_TRANSCRIPT_LINE).endswith("\n"):
                    pass
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


class BundleFailed(Exception):
    """The bundle container did not produce a bundle for a reason other than there being no commits."""


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

    def recover(self) -> list[str]:
        """Finish every job still `running` as crashed: with one runner, nothing can still be running at start-up."""
        recovered = []
        for job_id in self._spool.job_ids():
            if self._spool.state(job_id) != "running":
                continue
            now = self._clock()
            self._spool.finish(job_id, _record(job_id, CRASHED, now, now), {})
            self._clean(job_id)
            recovered.append(job_id)
        return recovered

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
        """Handle the oldest queued job nobody else has claimed; return its id, or None when there was none."""
        for job_id in self._spool.job_ids():
            if self._spool.state(job_id) == "queued" and self._spool.claim(job_id, self._clock()):
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
                self._spool.finish(job_id, _record(job_id, CRASHED, started, self._clock()), {})
            log.info("job %s: %s", job_id, outcome.status)
        except Exception as error:
            log.error("job %s: no run record could be written: %s", job_id, type(error).__name__)
        finally:
            self._clean(job_id)

    def _clean(self, job_id: str) -> None:
        for path in (self._work / job_id, self._work / "staging" / job_id):
            try:
                remove_tree(path)
            except OSError as error:
                log.error("job %s: a work directory could not be removed: %s", job_id, type(error).__name__)

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
        transcript = transcripts / f"{job_id}.jsonl"
        argv = pod.agent_argv(request, mounts, self._settings.image, name)
        with _private_file(transcript) as stdout, _private_file(transcripts / f"{job_id}.err") as stderr:
            try:
                self._run(argv, cwd=self._work, stdout=stdout, stderr=stderr,
                          timeout=request["timeout_minutes"] * 60)
            except subprocess.TimeoutExpired:
                self._remove_container(name)
                return Outcome("timeout")
        facts = pod.read_transcript(transcript_lines(transcript))
        result = _take(mounts.out / "result.json", MAX_RESULT_BYTES, staging / "result.json")
        if facts.limited and result is None:
            return Outcome("usage_limit", facts=facts)
        if facts.subtype == "error_max_turns":
            return Outcome("crashed", "max_turns", facts)
        if result is None:
            return Outcome("crashed", "agent_error", facts)
        files = {"result.json": result}
        try:
            bundle = self._bundle(job_id, request, mounts, staging)
        except BundleFailed:
            return Outcome("crashed", "internal", facts)
        if bundle is not None:
            files["commits.bundle"] = bundle
        return Outcome("completed", None, facts, files)

    def _bundle(self, job_id: str, request: Mapping, mounts: pod.Mounts, staging: Path) -> Path | None:
        """Bundle the agent's commits in a container; None when there are none or the bundle is not usable."""
        bundle = mounts.out / "commits.bundle"
        if os.path.lexists(bundle):
            bundle.unlink()  # whatever the agent left under this name is not the runner's bundle
        name = f"factory-{job_id}-bundle"
        argv = pod.bundle_argv(request, mounts, self._settings.image, name)
        errors = staging / "bundle.err"
        with _private_file(errors) as stderr:
            try:
                status = self._run(argv, cwd=self._work, stderr=stderr, timeout=BUNDLE_SECONDS)
            except subprocess.TimeoutExpired:
                self._remove_container(name)
                raise BundleFailed from None
        if status != 0:
            try:
                text = read_bounded(errors, MAX_STDERR_BYTES).decode("utf-8", errors="replace")
            except SpoolError:
                raise BundleFailed from None
            if EMPTY_BUNDLE not in text:
                raise BundleFailed
            return None
        return _take(bundle, self._config.dispatcher.max_bundle_megabytes * MEGABYTE, staging / "commits.bundle")

    def _remove_container(self, name: str) -> None:
        """Best effort: a container that outlived its timeout must not keep running."""
        for argv in (["podman", "kill", name], ["podman", "rm", "-f", name]):
            try:
                self._run(argv, cwd=self._work, timeout=CLEANUP_SECONDS)
            except (OSError, subprocess.TimeoutExpired):
                log.error("%s did not finish", " ".join(argv[:2]))


def _private_file(path: Path) -> BinaryIO:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0), PRIVATE_MODE)
    return os.fdopen(descriptor, "wb")


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
        "image: ok" if image else "image: missing or not the one the harness describes",
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
        if handled is None:
            _sleep(stop, IDLE_SECONDS)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="factory.runner", description="Run the factory's queued jobs.")
    parser.add_argument("--once", action="store_true", help="handle at most one job and exit")
    parser.add_argument("--check", action="store_true", help="check confinement, image and spool; write nothing")
    args = parser.parse_args(argv)
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        settings = settings_from_env(os.environ)
    except SettingsError as error:
        log.error("settings: %s", error)
        return 2
    spool = Spool(settings.spool_dir)
    runner = Runner(settings, load_config(), spool)
    if args.check:
        healthy, lines = check(runner, spool)
        print("\n".join(lines))
        return 0 if healthy else 1
    try:
        spool.prepare("runner")
        runner.prune_transcripts()
        recovered = runner.recover()
    except (SpoolError, OSError) as error:
        log.error("start-up failed: %s", type(error).__name__)
        return 1
    if recovered:
        log.warning("finished %d job(s) left running as crashed", len(recovered))
    stop = threading.Event()
    for name in ("SIGINT", "SIGTERM"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), lambda *_: stop.set())
    serve(runner, stop, once=args.once)
    return 0


if __name__ == "__main__":
    sys.exit(main())

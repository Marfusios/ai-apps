"""The spool directory the dispatcher and the runner share: job ids, layout, states and safe reads."""

import errno
import json
import os
import re
import secrets
import shutil
import stat
from collections.abc import Iterator, Mapping
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

JOB_ID = re.compile(r"[0-9]{8}T[0-9]{6}Z-[a-z_]{1,20}-[0-9]{1,9}-[0-9a-f]{8}")
RUN_STATUSES = ("completed", "timeout", "crashed", "usage_limit", "refused")
RUN_REASONS = ("firewall", "image", "toolchain", "services", "request", "clone", "max_turns", "agent_error",
               "internal")
KEEP_DAYS = 14
MAX_RECORD_BYTES = 20_000

RUN_KEYS = ("schema", "job_id", "status", "reason", "started_at", "finished_at", "duration_seconds", "model",
            "turns", "resets_at")
REASON_REQUIRED = ("refused", "crashed")
MAX_UNIX_SECONDS = 4_102_444_800  # the year 2100: anything later is not a real reset time
MODEL_NAME = re.compile(r"[A-Za-z0-9._:\[\]-]{0,100}")
COMMIT_SHA = re.compile(r"[0-9a-f]{40}")
THREAD_ID = re.compile(r"[A-Za-z0-9_=-]{1,100}")  # a review thread's node id, which goes into a marker
MAX_ROUND = 1_000  # the most fix or revise rounds a request or a run comment may name
STAMP = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
JOBS_MODE = 0o2750  # the runner's group may read jobs
RUNS_MODE = 0o2770  # the runner's group may create run directories
STALE_INCOMING = timedelta(days=1)
CHUNK = 65536
SYNC_UNSUPPORTED = (errno.EINVAL, errno.ENOTSUP, errno.EOPNOTSUPP)


class SpoolError(Exception):
    """A spool file or id is unusable. Messages name files by their job-relative name, never a host path."""


class SpoolMissing(SpoolError):
    """The file to read is not there; any other refusal (a link, a special file, one too large) is a SpoolError."""


@contextmanager
def _spool_errors(what: str) -> Iterator[None]:
    """Turn an operating system error into a SpoolError that names `what` but no host path."""
    try:
        yield
    except OSError as error:
        raise SpoolError(f"{what}: {error.strerror or type(error).__name__}") from error


def _utc(moment: datetime) -> datetime:
    """The one place a timestamp is checked: naive datetimes are a caller's bug, not local time."""
    if moment.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return moment.astimezone(timezone.utc)


def _stamp(moment: datetime) -> str:
    return _utc(moment).strftime(TIME_FORMAT)


def new_job_id(stage: str, issue: int, now: datetime) -> str:
    job_id = f"{_utc(now):%Y%m%dT%H%M%SZ}-{stage}-{issue}-{secrets.token_hex(4)}"
    if not JOB_ID.fullmatch(job_id):
        raise SpoolError("a job id needs a stage of 1 to 20 lowercase letters or underscores "
                         "and an issue number of 0 to 999999999")
    return job_id


def _open_flags() -> int:
    return (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            | getattr(os, "O_BINARY", 0))


def _read_open(name: str, limit: int, *, path: Path | None = None, dir_fd: int | None = None) -> bytes:
    """Open `path` (or `name` inside `dir_fd`) and read it under the rules of `read_bounded`."""
    try:
        descriptor = os.open(name if dir_fd is not None else path, _open_flags(), dir_fd=dir_fd)
    except FileNotFoundError:
        raise SpoolMissing(f"{name} is missing") from None
    except OSError:
        raise SpoolError(f"{name} cannot be opened") from None
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise SpoolError(f"{name} is not a regular file")
        chunks, remaining = [], limit + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(remaining, CHUNK))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
    except OSError:
        raise SpoolError(f"{name} cannot be read") from None
    finally:
        os.close(descriptor)
    data = b"".join(chunks)
    if len(data) > limit:
        raise SpoolError(f"{name} is too large (over {limit} bytes)")
    return data


def read_bounded(path: Path, limit: int) -> bytes:
    """Read a regular file of at most `limit` bytes; refuse links, special files and larger files.

    The file may be hostile, so it is never read past `limit + 1` bytes and never followed through a link.
    Only the last path component is checked: use `Spool.read_run_file` for files the runner wrote.
    """
    if os.path.islink(path):
        raise SpoolError(f"{path.name} is a symbolic link")
    return _read_open(path.name, limit, path=path)


def _is_real_directory(path: Path) -> bool:
    """True for a directory that is neither a link nor a reparse point (a junction on Windows)."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    reparse = getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)
    return stat.S_ISDIR(info.st_mode) and not reparse


def _is_integer(value: object, low: int, high: int | None = None) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= low and (high is None or value <= high)


def _is_stamp(value: object) -> bool:
    if not isinstance(value, str) or not STAMP.fullmatch(value):
        return False
    try:
        datetime.strptime(value, TIME_FORMAT)
    except ValueError:
        return False
    return True


def validate_run(data: object) -> list[str]:
    """Return every problem of a `run.json` record; an empty list means it is valid."""
    if not isinstance(data, dict):
        return ["run.json: must be an object"]
    problems = [f"run.json: missing key {key}" for key in RUN_KEYS if key not in data]
    unknown = sum(1 for key in data if key not in RUN_KEYS)
    if unknown:
        problems.append(f"run.json: has {unknown} unknown key(s)")
    status, reason = data.get("status"), data.get("reason")
    checks = (
        ("schema", "schema" not in data or _is_integer(data["schema"], 1, 1), "must be 1"),
        ("job_id", "job_id" not in data or (isinstance(data["job_id"], str) and bool(JOB_ID.fullmatch(data["job_id"]))),
         "must be a job id"),
        ("status", "status" not in data or status in RUN_STATUSES, f"must be one of {', '.join(RUN_STATUSES)}"),
        ("reason", "reason" not in data or reason is None or reason in RUN_REASONS,
         f"must be null or one of {', '.join(RUN_REASONS)}"),
        ("started_at", "started_at" not in data or _is_stamp(data["started_at"]), "must be YYYY-MM-DDTHH:MM:SSZ"),
        ("finished_at", "finished_at" not in data or _is_stamp(data["finished_at"]), "must be YYYY-MM-DDTHH:MM:SSZ"),
        ("duration_seconds", "duration_seconds" not in data or _is_integer(data["duration_seconds"], 0, 1_000_000),
         "must be an integer from 0 to 1000000"),
        ("model", "model" not in data or (isinstance(data["model"], str) and bool(MODEL_NAME.fullmatch(data["model"]))),
         "must be at most 100 characters of letters, digits and . _ : [ ] -"),
        ("turns", "turns" not in data or data["turns"] is None or _is_integer(data["turns"], 0, 100_000),
         "must be null or an integer from 0 to 100000"),
        ("resets_at", "resets_at" not in data or data["resets_at"] is None
         or _is_integer(data["resets_at"], 0, MAX_UNIX_SECONDS),
         f"must be null or an integer of Unix seconds from 0 to {MAX_UNIX_SECONDS}"),
    )
    problems += [f"{key}: {rule}" for key, valid, rule in checks if not valid]
    if status in REASON_REQUIRED and "reason" in data and reason is None:
        problems.append(f"reason: is required when the status is {status}")
    return problems


def _plain_name(name: str) -> str:
    if not isinstance(name, str) or not name or name in (".", "..") or "/" in name or "\\" in name or "\x00" in name:
        raise SpoolError("a file name must be a plain name without a path")
    return name


def _check_id(job_id: str) -> str:
    if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
        raise SpoolError("not a job id")
    return job_id


def _make_directory(path: Path, mode: int, *, idempotent: bool = False) -> None:
    """Create a directory with its mode; `idempotent` also creates parents and accepts an existing one."""
    path.mkdir(parents=idempotent, exist_ok=idempotent)
    os.chmod(path, mode)


def _write_json(path: Path, record: Mapping[str, object]) -> None:
    """Write through a temporary name in the same directory so a reader never sees half a file.

    The content reaches the disk before the rename, so a power loss cannot leave an empty file under the name. A
    file system that cannot sync a file says so with one of SYNC_UNSUPPORTED; any other failure is an error.
    """
    temporary = path.with_name(f".{path.name}.tmp")
    with open(temporary, "w", encoding="utf-8") as stream:
        stream.write(json.dumps(dict(record), indent=2) + "\n")
        stream.flush()
        try:
            os.fsync(stream.fileno())
        except OSError as error:
            if error.errno not in SYNC_UNSUPPORTED:
                raise
    os.replace(temporary, path)


def _parse_json(data: bytes, name: str) -> object:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        raise SpoolError(f"{name} is not valid JSON") from None


class Spool:
    """The directory layout: `jobs/<id>/` is written by the dispatcher, `runs/<id>/` by the runner.

    The dispatcher creates both top-level directories; the runner only checks that `runs/` exists.
    Everything the dispatcher reads from `runs/` goes through `read_run_file` or `run_record`.
    """

    def __init__(self, root: Path):
        self.root = Path(root)

    @property
    def _jobs(self) -> Path:
        return self.root / "jobs"

    @property
    def _runs(self) -> Path:
        return self.root / "runs"

    def prepare(self, side: str) -> None:
        if side == "dispatcher":
            with _spool_errors("the spool cannot be prepared"):
                _make_directory(self._jobs, JOBS_MODE, idempotent=True)
                _make_directory(self._runs, RUNS_MODE, idempotent=True)
        elif side == "runner":
            if not _is_real_directory(self._runs):
                raise SpoolError("runs/ is missing or not a directory: start the dispatcher first")
        else:
            raise SpoolError("side must be dispatcher or runner")

    def submit(self, job_id: str, files: Mapping[str, bytes]) -> None:
        """Publish a job all at once: write it under a hidden name, then rename it."""
        _check_id(job_id)
        names = [_plain_name(name) for name in files]
        if not _is_real_directory(self._jobs):
            raise SpoolError("jobs/ is missing: prepare the spool first")
        target = self._jobs / job_id
        incoming = self._jobs / f".incoming-{job_id}"
        if os.path.lexists(target):
            raise SpoolError("this job already exists")
        with _spool_errors("the job cannot be submitted"):
            try:
                _make_directory(incoming, JOBS_MODE)
            except FileExistsError:
                raise SpoolError("this job is already being submitted") from None
            try:
                for name in names:
                    (incoming / name).write_bytes(files[name])
                incoming.rename(target)
            except BaseException:
                shutil.rmtree(incoming, ignore_errors=True)
                raise

    def job_ids(self) -> list[str]:
        if not self._jobs.is_dir():
            return []
        return sorted(entry.name for entry in self._jobs.iterdir()
                      if JOB_ID.fullmatch(entry.name) and _is_real_directory(entry))

    def state(self, job_id: str) -> str:
        _check_id(job_id)
        run = self._runs / job_id
        if os.path.lexists(self._jobs / job_id / "closed.json"):
            return "closed"
        if os.path.lexists(run) and not _is_real_directory(run):
            return "finished"  # hostile: the dispatcher must look at it, and run_record will refuse it
        if os.path.lexists(run / "run.json"):
            return "finished"
        if os.path.lexists(run / "claimed.json"):
            return "running"
        return "queued"

    def request(self, job_id: str) -> dict:
        record = self.read_job_json(job_id, "request.json")
        if record is None:
            raise SpoolMissing("request.json is missing")
        return record

    def job_file(self, job_id: str, name: str) -> Path:
        return self._jobs / _check_id(job_id) / _plain_name(name)

    def write_job_json(self, job_id: str, name: str, record: Mapping[str, object]) -> None:
        """Write a record of the dispatcher's own into the job's directory, whole or not at all."""
        path = self.job_file(job_id, name)
        with _spool_errors(f"{name} cannot be written"):
            _write_json(path, record)

    def read_job_json(self, job_id: str, name: str, limit: int = MAX_RECORD_BYTES) -> dict | None:
        """A JSON object the dispatcher wrote into the job's directory, or None when there is none."""
        try:
            data = read_bounded(self.job_file(job_id, name), limit)
        except SpoolMissing:
            return None
        record = _parse_json(data, name)
        if not isinstance(record, dict):
            raise SpoolError(f"{name}: must be an object")
        return record

    def close(self, job_id: str, reason: str, now: datetime) -> None:
        self.write_job_json(job_id, "closed.json", {"reason": reason, "closed_at": _stamp(now)})

    def claim(self, job_id: str, now: datetime) -> bool:
        """Take a job by creating its run directory; only one caller can."""
        _check_id(job_id)
        if not _is_real_directory(self._runs):
            raise SpoolError("runs/ is missing or not a directory: start the dispatcher first")
        run = self._runs / job_id
        with _spool_errors("the job cannot be claimed"):
            try:
                _make_directory(run, JOBS_MODE)
            except FileExistsError:
                return False
            try:
                _write_json(run / "claimed.json", {"claimed_at": _stamp(now)})
            except BaseException:
                shutil.rmtree(run, ignore_errors=True)
                raise
        return True

    def finish(self, job_id: str, run: Mapping[str, object], files: Mapping[str, Path]) -> None:
        """Copy the result files, then publish `run.json` atomically so a reader never sees it early."""
        _check_id(job_id)
        names = [_plain_name(name) for name in files]
        directory = self._runs / job_id
        with _spool_errors("the run cannot be finished"):
            for name, source in zip(names, files.values()):
                shutil.copyfile(source, directory / name)
            _write_json(directory / "run.json", run)

    def read_run_file(self, job_id: str, name: str, limit: int) -> bytes:
        """Read a file the runner wrote: the only way the dispatcher may read `runs/`.

        Refuses a link or non-directory at `runs/<id>` as well as at the file. Where the platform allows,
        the file is opened relative to the opened directory so nothing can be swapped in between.
        """
        _check_id(job_id)
        _plain_name(name)
        directory = self._runs / job_id
        if os.open in os.supports_dir_fd and hasattr(os, "O_DIRECTORY") and hasattr(os, "O_NOFOLLOW"):
            try:
                dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            except OSError:
                raise SpoolError("the run directory is missing, a link or not a directory") from None
            try:
                return _read_open(name, limit, dir_fd=dir_fd)
            finally:
                os.close(dir_fd)
        if not _is_real_directory(directory):
            raise SpoolError("the run directory is missing, a link or not a directory")
        return read_bounded(directory / name, limit)

    def run_record(self, job_id: str) -> dict:
        data = _parse_json(self.read_run_file(job_id, "run.json", MAX_RECORD_BYTES), "run.json")
        problems = validate_run(data)
        if not problems and data["job_id"] != job_id:
            problems.append("run.json names another job")
        if problems:
            raise SpoolError("; ".join(problems))
        return data

    def prune(self, side: str, now: datetime) -> list[str]:
        """Remove what the given side owns and no longer needs; return the removed job ids."""
        if side == "dispatcher":
            return self._prune_jobs(_utc(now))
        if side == "runner":
            _utc(now)
            return self._prune_runs()
        raise SpoolError("side must be dispatcher or runner")

    def _prune_jobs(self, now: datetime) -> list[str]:
        if not _is_real_directory(self._jobs):
            return []
        removed = []
        with _spool_errors("jobs cannot be pruned"):
            for entry in sorted(self._jobs.iterdir(), key=lambda item: item.name):
                if not _is_real_directory(entry):
                    continue
                if entry.name.startswith(".incoming-"):
                    if now.timestamp() - entry.stat().st_mtime > STALE_INCOMING.total_seconds():
                        shutil.rmtree(entry)
                elif JOB_ID.fullmatch(entry.name) and self._closed_before(entry.name, now - timedelta(days=KEEP_DAYS)):
                    shutil.rmtree(entry)
                    removed.append(entry.name)
        return removed

    def _prune_runs(self) -> list[str]:
        if not _is_real_directory(self._jobs) or not _is_real_directory(self._runs):
            return []
        removed = []
        with _spool_errors("runs cannot be pruned"):
            for entry in sorted(self._runs.iterdir(), key=lambda item: item.name):
                if (JOB_ID.fullmatch(entry.name) and _is_real_directory(entry)
                        and not os.path.lexists(self._jobs / entry.name)):
                    shutil.rmtree(entry)
                    removed.append(entry.name)
        return removed

    def _closed_before(self, job_id: str, cutoff: datetime) -> bool:
        try:
            record = _parse_json(read_bounded(self.job_file(job_id, "closed.json"), MAX_RECORD_BYTES), "closed.json")
        except SpoolError:
            return False
        closed_at = record.get("closed_at") if isinstance(record, dict) else None
        return _is_stamp(closed_at) and datetime.strptime(closed_at, TIME_FORMAT).replace(
            tzinfo=timezone.utc) < cutoff

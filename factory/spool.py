"""The spool directory the dispatcher and the runner share: job ids, layout, states and safe reads."""

import json
import os
import re
import secrets
import shutil
import stat
from collections.abc import Mapping
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
DIRECTORY_MODE = 0o2750
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"
SIDES = {"dispatcher": "jobs", "runner": "runs"}


class SpoolError(Exception):
    """A spool file or id is unusable. Messages name files by their job-relative name, never a host path."""


def _stamp(moment: datetime) -> str:
    if moment.tzinfo is None:
        raise ValueError("timestamps must be timezone-aware")
    return moment.astimezone(timezone.utc).strftime(TIME_FORMAT)


def new_job_id(stage: str, issue: int, now: datetime) -> str:
    job_id = f"{now.astimezone(timezone.utc):%Y%m%dT%H%M%SZ}-{stage}-{issue}-{secrets.token_hex(4)}"
    if not JOB_ID.fullmatch(job_id):
        raise SpoolError("a job id needs a stage of 1 to 20 lowercase letters or underscores "
                         "and an issue number of 0 to 999999999")
    return job_id


def read_bounded(path: Path, limit: int) -> bytes:
    """Read a regular file of at most `limit` bytes; refuse links, special files and larger files.

    The file may be hostile, so it is never read past `limit + 1` bytes and never followed through a link.
    """
    name = path.name
    if os.path.islink(path):
        raise SpoolError(f"{name} is a symbolic link")
    flags = (os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
             | getattr(os, "O_BINARY", 0))
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        raise SpoolError(f"{name} is missing") from None
    except OSError:
        raise SpoolError(f"{name} cannot be opened") from None
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise SpoolError(f"{name} is not a regular file")
        chunks, remaining = [], limit + 1
        while remaining > 0:
            chunk = os.read(descriptor, min(remaining, 65536))
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
        raise SpoolError(f"{name} is larger than {limit} bytes")
    return data


def _is_integer(value: object, low: int, high: int | None = None) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= low and (high is None or value <= high)


def _is_stamp(value: object) -> bool:
    if not isinstance(value, str):
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
        ("schema", "schema" not in data or (_is_integer(data["schema"], 1, 1)), "must be 1"),
        ("job_id", "job_id" not in data or (isinstance(data["job_id"], str) and bool(JOB_ID.fullmatch(data["job_id"]))),
         "must be a job id"),
        ("status", "status" not in data or status in RUN_STATUSES, f"must be one of {', '.join(RUN_STATUSES)}"),
        ("reason", "reason" not in data or reason is None or reason in RUN_REASONS,
         f"must be null or one of {', '.join(RUN_REASONS)}"),
        ("started_at", "started_at" not in data or _is_stamp(data["started_at"]), "must be YYYY-MM-DDTHH:MM:SSZ"),
        ("finished_at", "finished_at" not in data or _is_stamp(data["finished_at"]), "must be YYYY-MM-DDTHH:MM:SSZ"),
        ("duration_seconds", "duration_seconds" not in data or _is_integer(data["duration_seconds"], 0, 1_000_000),
         "must be an integer from 0 to 1000000"),
        ("model", "model" not in data or (isinstance(data["model"], str) and len(data["model"]) <= 100),
         "must be a string of at most 100 characters"),
        ("turns", "turns" not in data or data["turns"] is None or _is_integer(data["turns"], 0, 100_000),
         "must be null or an integer from 0 to 100000"),
        ("resets_at", "resets_at" not in data or data["resets_at"] is None or _is_integer(data["resets_at"], 0),
         "must be null or an integer of Unix seconds"),
    )
    problems += [f"{key}: {rule}" for key, valid, rule in checks if not valid]
    if status in REASON_REQUIRED and "reason" in data and reason is None:
        problems.append(f"reason: is required when the status is {status}")
    return problems


def _plain_name(name: str) -> str:
    if not name or name in (".", "..") or "/" in name or "\\" in name or "\x00" in name:
        raise SpoolError("a file name must be a plain name without a path")
    return name


def _check_id(job_id: str) -> str:
    if not isinstance(job_id, str) or not JOB_ID.fullmatch(job_id):
        raise SpoolError("not a job id")
    return job_id


def _make_directory(path: Path, *, exist_ok: bool = False) -> None:
    path.mkdir(parents=True, exist_ok=exist_ok)
    os.chmod(path, DIRECTORY_MODE)


def _write_json(path: Path, record: Mapping[str, object]) -> None:
    path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")


def _side(side: str) -> str:
    if side not in SIDES:
        raise SpoolError("side must be dispatcher or runner")
    return SIDES[side]


class Spool:
    """The directory layout: `jobs/<id>/` is written by the dispatcher, `runs/<id>/` by the runner."""

    def __init__(self, root: Path):
        self.root = Path(root)

    def prepare(self, side: str) -> None:
        _make_directory(self.root / _side(side), exist_ok=True)

    def submit(self, job_id: str, files: Mapping[str, bytes]) -> None:
        """Publish a job all at once: write it under a hidden name, then rename it."""
        _check_id(job_id)
        names = [_plain_name(name) for name in files]
        target = self.root / "jobs" / job_id
        incoming = self.root / "jobs" / f".incoming-{job_id}"
        if target.exists():
            raise SpoolError("this job already exists")
        try:
            _make_directory(incoming)
            for name in names:
                (incoming / name).write_bytes(files[name])
            incoming.rename(target)
        except FileExistsError:
            raise SpoolError("this job is already being submitted") from None
        except BaseException:
            shutil.rmtree(incoming, ignore_errors=True)
            raise

    def job_ids(self) -> list[str]:
        jobs = self.root / "jobs"
        if not jobs.is_dir():
            return []
        return sorted(entry.name for entry in jobs.iterdir()
                      if JOB_ID.fullmatch(entry.name) and entry.is_dir() and not entry.is_symlink())

    def state(self, job_id: str) -> str:
        _check_id(job_id)
        if os.path.lexists(self.root / "jobs" / job_id / "closed.json"):
            return "closed"
        if os.path.lexists(self.root / "runs" / job_id / "run.json"):
            return "finished"
        if os.path.lexists(self.root / "runs" / job_id / "claimed.json"):
            return "running"
        return "queued"

    def request(self, job_id: str) -> dict:
        data = self._json(self.job_file(job_id, "request.json"))
        if not isinstance(data, dict):
            raise SpoolError("request.json: must be an object")
        return data

    def job_file(self, job_id: str, name: str) -> Path:
        return self.root / "jobs" / _check_id(job_id) / _plain_name(name)

    def run_file(self, job_id: str, name: str) -> Path:
        return self.root / "runs" / _check_id(job_id) / _plain_name(name)

    def close(self, job_id: str, reason: str, now: datetime) -> None:
        _write_json(self.job_file(job_id, "closed.json"), {"reason": reason, "closed_at": _stamp(now)})

    def claim(self, job_id: str, now: datetime) -> bool:
        """Take a job by creating its run directory; only one caller can."""
        _check_id(job_id)
        try:
            _make_directory(self.root / "runs" / job_id)
        except FileExistsError:
            return False
        _write_json(self.run_file(job_id, "claimed.json"), {"claimed_at": _stamp(now)})
        return True

    def finish(self, job_id: str, run: Mapping[str, object], files: Mapping[str, Path]) -> None:
        """Copy the result files, then publish `run.json` atomically so a reader never sees it early."""
        directory = self.run_file(job_id, "run.json").parent
        for name, source in files.items():
            shutil.copyfile(source, directory / _plain_name(name))
        temporary = directory / ".run.json.tmp"
        _write_json(temporary, run)
        os.replace(temporary, directory / "run.json")

    def run_record(self, job_id: str) -> dict:
        data = self._json(self.run_file(job_id, "run.json"))
        problems = validate_run(data)
        if problems:
            raise SpoolError("; ".join(problems))
        return data

    def prune(self, side: str, now: datetime) -> list[str]:
        """Remove what the given side owns and no longer needs; return the removed ids."""
        directory = self.root / _side(side)
        if not directory.is_dir():
            return []
        removed = []
        for entry in sorted(directory.iterdir(), key=lambda item: item.name):
            if not JOB_ID.fullmatch(entry.name) or not entry.is_dir() or entry.is_symlink():
                continue
            expired = (self._closed_before(entry.name, now - timedelta(days=KEEP_DAYS)) if side == "dispatcher"
                       else not (self.root / "jobs" / entry.name).exists())
            if expired:
                shutil.rmtree(entry)
                removed.append(entry.name)
        return removed

    def _closed_before(self, job_id: str, cutoff: datetime) -> bool:
        try:
            record = self._json(self.job_file(job_id, "closed.json"))
        except SpoolError:
            return False
        closed_at = record.get("closed_at") if isinstance(record, dict) else None
        return _is_stamp(closed_at) and datetime.strptime(closed_at, TIME_FORMAT).replace(
            tzinfo=timezone.utc) < cutoff

    @staticmethod
    def _json(path: Path) -> object:
        try:
            return json.loads(read_bounded(path, MAX_RECORD_BYTES).decode("utf-8"))
        except (UnicodeDecodeError, ValueError, RecursionError):
            raise SpoolError(f"{path.name} is not valid JSON") from None

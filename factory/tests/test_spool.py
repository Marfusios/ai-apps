"""Tests for the spool directory shared by the dispatcher and the runner."""

import errno
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from factory.spool import (MAX_RECORD_BYTES, Spool, SpoolError, SpoolMissing, new_job_id, read_bounded,
                           validate_run)

NOW = datetime(2026, 11, 27, 10, 15, 0, tzinfo=timezone.utc)
CAN_SYMLINK = hasattr(os, "symlink")


def run_record(job_id: str) -> dict:
    return {
        "schema": 1,
        "job_id": job_id,
        "status": "completed",
        "reason": None,
        "started_at": "2026-11-27T10:15:00Z",
        "finished_at": "2026-11-27T10:20:00Z",
        "duration_seconds": 300,
        "model": "some-model",
        "turns": 12,
        "resets_at": None,
    }


class SpoolTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.root = self.tmp / "spool"

    def file(self, content: bytes, name: str = "source.bin") -> Path:
        path = self.tmp / name
        path.write_bytes(content)
        return path

    def ready(self) -> Spool:
        spool = Spool(self.root)
        spool.prepare("dispatcher")
        spool.prepare("runner")
        return spool


class SpoolLifecycleTest(SpoolTestCase):
    def test_a_job_moves_through_its_states(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 12, NOW)
        spool.submit(job, {"request.json": b'{"schema": 1}', "context.md": b"text"})
        self.assertEqual((spool.job_ids(), spool.state(job)), ([job], "queued"))
        self.assertEqual(spool.request(job), {"schema": 1})
        self.assertTrue(spool.claim(job, NOW))
        self.assertFalse(spool.claim(job, NOW))
        self.assertEqual(spool.state(job), "running")
        spool.finish(job, run_record(job), {"result.json": self.file(b"{}")})
        self.assertEqual(spool.state(job), "finished")
        self.assertEqual(spool.read_run_file(job, "result.json", 10), b"{}")
        self.assertEqual(spool.run_record(job)["status"], "completed")
        spool.close(job, "published", NOW)
        self.assertEqual(spool.state(job), "closed")
        closed = json.loads(spool.job_file(job, "closed.json").read_text())
        self.assertEqual(closed, {"reason": "published", "closed_at": "2026-11-27T10:15:00Z"})

    def test_new_job_id_has_the_documented_shape_and_is_unique(self):
        first, second = new_job_id("fix_issue", 12, NOW), new_job_id("fix_issue", 12, NOW)
        self.assertTrue(first.startswith("20261127T101500Z-fix_issue-12-"))
        self.assertNotEqual(first, second)

    def test_new_job_id_refuses_parts_that_would_not_match(self):
        for stage, issue in (("Fix", 1), ("", 1), ("x" * 21, 1), ("fix", -1), ("fix", 10**9)):
            with self.assertRaises(SpoolError):
                new_job_id(stage, issue, NOW)

    def test_submit_refuses_an_existing_job_and_leaves_no_partial_directory(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        with self.assertRaises(SpoolError):
            spool.submit(job, {"request.json": b"{}"})
        self.assertEqual(spool.job_ids(), [job])

    def test_submit_refuses_file_names_with_a_path(self):
        spool = self.ready()
        with self.assertRaises(SpoolError):
            spool.submit(new_job_id("fix_issue", 1, NOW), {"../escape": b"x"})
        self.assertEqual(spool.job_ids(), [])

    def test_job_ids_ignores_half_written_and_foreign_directories(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 3, NOW)
        spool.submit(job, {"request.json": b"{}"})
        jobs = self.root / "jobs"
        (jobs / f".incoming-{new_job_id('fix_issue', 4, NOW)}").mkdir()
        (jobs / "notes").mkdir()
        (jobs / "stray.txt").write_text("x")
        self.assertEqual(spool.job_ids(), [job])

    def test_job_ids_is_empty_before_the_dispatcher_prepared_the_spool(self):
        self.assertEqual(Spool(self.root).job_ids(), [])

    def test_ids_that_are_not_job_ids_are_refused(self):
        for bad in ("../../etc", "20261127T101500Z-fix_issue-12-1A2B3C4D", "", "a/b"):
            with self.assertRaises(SpoolError):
                Spool(self.root).state(bad)

    def test_every_method_checks_the_id_before_touching_the_file_system(self):
        spool, bad = Spool(self.root), "../x"
        calls = (
            lambda: spool.submit(bad, {}), lambda: spool.request(bad),
            lambda: spool.job_file(bad, "a"), lambda: spool.read_run_file(bad, "a", 1),
            lambda: spool.close(bad, "r", NOW), lambda: spool.claim(bad, NOW),
            lambda: spool.finish(bad, {}, {}), lambda: spool.run_record(bad),
            lambda: spool.write_job_json(bad, "a.json", {}), lambda: spool.read_job_json(bad, "a.json"),
        )
        for call in calls:
            with self.assertRaises(SpoolError):
                call()
        self.assertFalse(self.root.exists())

    def test_file_names_must_be_plain(self):
        spool = Spool(self.root)
        job = new_job_id("fix_issue", 1, NOW)
        for bad in ("", "..", ".", "a/b", "a\\b", "../x"):
            with self.assertRaises(SpoolError):
                spool.job_file(job, bad)
            with self.assertRaises(SpoolError):
                spool.read_run_file(job, bad, 10)
            with self.assertRaises(SpoolError):
                spool.write_job_json(job, bad, {})
            with self.assertRaises(SpoolError):
                spool.read_job_json(job, bad)

    def test_finish_writes_run_json_last_and_leaves_no_temporary_file(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        spool.claim(job, NOW)
        missing = self.tmp / "absent.bundle"
        with self.assertRaises(SpoolError) as caught:
            spool.finish(job, run_record(job), {"commits.bundle": missing})
        self.assertNotIn(str(self.tmp), str(caught.exception))
        self.assertEqual(spool.state(job), "running")
        spool.finish(job, run_record(job), {"commits.bundle": self.file(b"B")})
        self.assertEqual(sorted(p.name for p in (self.root / "runs" / job).iterdir()),
                         ["claimed.json", "commits.bundle", "run.json"])

    def test_prepare_refuses_an_unknown_side(self):
        with self.assertRaises(SpoolError):
            Spool(self.root).prepare("someone")

    def test_the_dispatcher_creates_both_directories_and_the_runner_creates_none(self):
        spool = Spool(self.root)
        with self.assertRaises(SpoolError):
            spool.prepare("runner")
        self.assertFalse(self.root.exists())
        spool.prepare("dispatcher")
        spool.prepare("runner")
        self.assertTrue((self.root / "jobs").is_dir() and (self.root / "runs").is_dir())

    def test_submit_and_claim_do_not_create_missing_parents(self):
        spool = Spool(self.root)
        job = new_job_id("fix_issue", 1, NOW)
        with self.assertRaises(SpoolError):
            spool.submit(job, {"request.json": b"{}"})
        with self.assertRaises(SpoolError):
            spool.claim(job, NOW)
        self.assertFalse(self.root.exists())

    def test_operating_system_failures_become_spool_errors_without_host_paths(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        for call in (lambda: spool.close(job, "published", NOW),
                     lambda: spool.finish(job, run_record(job), {})):
            with self.assertRaises(SpoolError) as caught:
                call()
            self.assertNotIn(str(self.tmp), str(caught.exception))

    def test_close_leaves_no_temporary_file(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        spool.close(job, "published", NOW)
        self.assertEqual(sorted(p.name for p in (self.root / "jobs" / job).iterdir()),
                         ["closed.json", "request.json"])

    def test_finish_checks_every_name_before_copying(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.claim(job, NOW)
        with self.assertRaises(SpoolError):
            spool.finish(job, run_record(job), {"good.json": self.file(b"x"), "../bad": self.file(b"y", "y.bin")})
        self.assertEqual([p.name for p in (self.root / "runs" / job).iterdir()], ["claimed.json"])

    def test_naive_datetimes_are_refused_everywhere(self):
        spool = self.ready()
        naive = datetime(2026, 11, 27, 10, 15, 0)
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        for call in (lambda: new_job_id("fix_issue", 1, naive), lambda: spool.close(job, "r", naive),
                     lambda: spool.claim(job, naive), lambda: spool.prune("dispatcher", naive),
                     lambda: spool.prune("runner", naive)):
            with self.assertRaises(ValueError):
                call()

    def test_a_missing_request_is_missing(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"context.md": b"text"})
        with self.assertRaises(SpoolMissing):
            spool.request(job)

    @unittest.skipUnless(os.name == "posix", "directory modes only have an effect on POSIX")
    def test_prepare_applies_the_group_readable_setgid_mode(self):
        self.ready()
        self.assertEqual(os.stat(self.root / "jobs").st_mode & 0o7777, 0o2750)
        self.assertEqual(os.stat(self.root / "runs").st_mode & 0o7777, 0o2770)


class JobJsonTest(SpoolTestCase):
    def submitted(self) -> tuple[Spool, str]:
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        return spool, job

    def test_a_record_written_is_read_back_and_leaves_no_temporary_file(self):
        spool, job = self.submitted()
        spool.write_job_json(job, "settled.json", {"outcome": "done", "problems": ("a", "b"), "head_sha": None})
        self.assertEqual(spool.read_job_json(job, "settled.json"),
                         {"outcome": "done", "problems": ["a", "b"], "head_sha": None})
        spool.write_job_json(job, "settled.json", {"outcome": "crashed"})
        self.assertEqual(spool.read_job_json(job, "settled.json"), {"outcome": "crashed"})
        self.assertEqual(sorted(p.name for p in (self.root / "jobs" / job).iterdir()), ["request.json", "settled.json"])

    def test_a_record_that_is_not_there_reads_as_none(self):
        spool, job = self.submitted()
        self.assertIsNone(spool.read_job_json(job, "settled.json"))

    def test_a_record_that_is_not_a_json_object_or_too_large_is_refused(self):
        spool, job = self.submitted()
        path = spool.job_file(job, "settled.json")
        for content in (b"{not json", b"[1, 2]", b"\xff\xfe"):
            with self.subTest(content):
                path.write_bytes(content)
                with self.assertRaises(SpoolError):
                    spool.read_job_json(job, "settled.json")
        path.write_bytes(b'{"a": "' + b"x" * 100 + b'"}')
        self.assertEqual(spool.read_job_json(job, "settled.json", 200), {"a": "x" * 100})
        with self.assertRaises(SpoolError):
            spool.read_job_json(job, "settled.json", 50)

    @unittest.skipUnless(CAN_SYMLINK, "this platform has no symbolic links")
    def test_a_record_that_is_a_link_is_refused(self):
        spool, job = self.submitted()
        try:
            os.symlink(self.file(b'{"outcome": "done"}'), spool.job_file(job, "settled.json"))
        except OSError:
            self.skipTest("creating symbolic links is not permitted here")
        with self.assertRaises(SpoolError) as caught:
            spool.read_job_json(job, "settled.json")
        self.assertNotIsInstance(caught.exception, SpoolMissing)

    def test_a_record_reaches_the_disk_before_it_takes_its_name(self):
        spool, job = self.submitted()
        events = []
        real_fsync, real_replace = os.fsync, os.replace

        def fsync(descriptor):
            events.append("fsync")
            real_fsync(descriptor)

        def replace(source, target):
            events.append("replace")
            real_replace(source, target)

        with mock.patch("factory.spool.os.fsync", side_effect=fsync), \
                mock.patch("factory.spool.os.replace", side_effect=replace):
            spool.write_job_json(job, "settled.json", {"outcome": "done"})
        self.assertEqual(events, ["fsync", "replace"])
        self.assertEqual(spool.read_job_json(job, "settled.json"), {"outcome": "done"})

    def test_a_file_system_that_cannot_sync_a_file_still_gets_the_record(self):
        spool, job = self.submitted()
        with mock.patch("factory.spool.os.fsync", side_effect=OSError(errno.EINVAL, "Invalid argument")):
            spool.write_job_json(job, "settled.json", {"outcome": "done"})
        self.assertEqual(spool.read_job_json(job, "settled.json"), {"outcome": "done"})

    def test_a_failed_sync_is_an_error_and_leaves_the_name_untouched(self):
        spool, job = self.submitted()
        spool.write_job_json(job, "settled.json", {"outcome": "done"})
        with mock.patch("factory.spool.os.fsync", side_effect=OSError(errno.EIO, "Input/output error")), \
                self.assertRaises(SpoolError) as caught:
            spool.write_job_json(job, "settled.json", {"outcome": "crashed"})
        self.assertNotIn(str(self.tmp), str(caught.exception))
        self.assertEqual(spool.read_job_json(job, "settled.json"), {"outcome": "done"})

    def test_writing_into_a_job_that_does_not_exist_fails_without_a_host_path(self):
        spool = self.ready()
        with self.assertRaises(SpoolError) as caught:
            spool.write_job_json(new_job_id("fix_issue", 1, NOW), "settled.json", {"outcome": "done"})
        self.assertNotIn(str(self.tmp), str(caught.exception))


class ReadBoundedTest(SpoolTestCase):
    def test_reads_a_file_within_the_limit(self):
        self.assertEqual(read_bounded(self.file(b"abc"), 3), b"abc")

    @unittest.skipUnless(CAN_SYMLINK, "this platform has no symbolic links")
    def test_read_bounded_refuses_a_symbolic_link(self):
        target = self.file(b"secret")
        link = self.tmp / "link"
        try:
            os.symlink(target, link)
        except OSError:
            self.skipTest("creating symbolic links is not permitted here")
        with self.assertRaises(SpoolError):
            read_bounded(link, 100)

    def test_read_bounded_refuses_a_directory_a_missing_file_and_an_oversized_file(self):
        with self.assertRaises(SpoolError) as directory:
            read_bounded(self.tmp, 100)
        with self.assertRaises(SpoolMissing):
            read_bounded(self.tmp / "absent", 100)
        with self.assertRaises(SpoolError) as oversized:
            read_bounded(self.file(b"abcd"), 3)
        self.assertNotIsInstance(directory.exception, SpoolMissing)
        self.assertNotIsInstance(oversized.exception, SpoolMissing)

    @unittest.skipUnless(hasattr(os, "mkfifo"), "this platform has no named pipes")
    def test_read_bounded_refuses_a_named_pipe_without_hanging(self):
        fifo = self.tmp / "pipe"
        os.mkfifo(fifo)
        with self.assertRaises(SpoolError):
            read_bounded(fifo, 100)

    def test_errors_do_not_contain_the_host_path(self):
        for path in (self.tmp, self.tmp / "absent"):
            with self.assertRaises(SpoolError) as caught:
                read_bounded(path, 10)
            self.assertNotIn(str(self.tmp), str(caught.exception))
        big = self.file(b"x" * 11, "big.json")
        with self.assertRaises(SpoolError) as caught:
            read_bounded(big, 10)
        self.assertIn("big.json", str(caught.exception))
        self.assertNotIn(str(self.tmp), str(caught.exception))


class RunRecordTest(SpoolTestCase):
    def finished(self, raw: object = None, **change: object) -> tuple[Spool, str]:
        """A claimed job whose run.json holds a valid record with `change` applied, or `raw` if given."""
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        spool.claim(job, NOW)
        record = {**run_record(job), **change} if raw is None else raw
        (self.root / "runs" / job / "run.json").write_text(json.dumps(record))
        return spool, job

    def test_run_record_rejects_an_unknown_status_and_an_unknown_key(self):
        for change in ({"status": "exploded"}, {"extra": 1}):
            spool, job = self.finished(**change)
            with self.assertRaises(SpoolError):
                spool.run_record(job)

    def test_run_record_rejects_an_oversized_file(self):
        spool, job = self.finished()
        path = self.root / "runs" / job / "run.json"
        path.write_text(path.read_text() + " " * MAX_RECORD_BYTES)
        with self.assertRaises(SpoolError) as caught:
            spool.run_record(job)
        self.assertIn("too large", str(caught.exception))

    def test_run_record_rejects_a_record_that_names_another_job(self):
        spool, job = self.finished(job_id=new_job_id("fix_issue", 2, NOW))
        with self.assertRaises(SpoolError) as caught:
            spool.run_record(job)
        self.assertIn("another job", str(caught.exception))

    def test_run_record_returns_a_valid_record(self):
        spool, job = self.finished()
        self.assertEqual(spool.run_record(job)["job_id"], job)

    def test_run_record_rejects_text_that_is_not_json_or_not_an_object(self):
        spool, job = self.finished([1, 2])
        with self.assertRaises(SpoolError):
            spool.run_record(job)
        (self.root / "runs" / job / "run.json").write_bytes(b"\xff\xfe not json")
        with self.assertRaises(SpoolError):
            spool.run_record(job)

    @unittest.skipUnless(CAN_SYMLINK, "this platform has no symbolic links")
    def test_a_run_directory_that_is_a_link_is_finished_but_unreadable(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        outside = self.tmp / "outside"
        outside.mkdir()
        (outside / "run.json").write_text(json.dumps(run_record(job)))
        (outside / "result.json").write_text("{}")
        try:
            os.symlink(outside, self.root / "runs" / job, target_is_directory=True)
        except OSError:
            self.skipTest("creating symbolic links is not permitted here")
        self.assertEqual(spool.state(job), "finished")
        for call in (lambda: spool.run_record(job), lambda: spool.read_run_file(job, "result.json", 10)):
            with self.assertRaises(SpoolError):
                call()

    def test_read_run_file_reads_and_bounds_a_regular_file(self):
        spool, job = self.finished()
        (self.root / "runs" / job / "result.json").write_bytes(b"12345")
        self.assertEqual(spool.read_run_file(job, "result.json", 5), b"12345")
        with self.assertRaises(SpoolError) as oversized:
            spool.read_run_file(job, "result.json", 4)
        self.assertNotIsInstance(oversized.exception, SpoolMissing)
        with self.assertRaises(SpoolMissing):
            spool.read_run_file(job, "absent.json", 4)

    @unittest.skipUnless(CAN_SYMLINK, "this platform has no symbolic links")
    def test_read_run_file_refuses_a_file_that_is_a_link(self):
        spool, job = self.finished()
        try:
            os.symlink(self.file(b"secret"), self.root / "runs" / job / "result.json")
        except OSError:
            self.skipTest("creating symbolic links is not permitted here")
        with self.assertRaises(SpoolError) as caught:
            spool.read_run_file(job, "result.json", 100)
        self.assertNotIsInstance(caught.exception, SpoolMissing)

    def test_validate_run_accepts_a_valid_record(self):
        self.assertEqual(validate_run(run_record(new_job_id("fix_issue", 1, NOW))), [])

    def test_validate_run_has_a_row_per_rule(self):
        job = new_job_id("fix_issue", 1, NOW)
        rows = (
            ("schema", 2), ("schema", True), ("job_id", "nope"), ("job_id", None),
            ("status", "bad"), ("status", 1),
            ("reason", "bad"), ("reason", 3),
            ("started_at", "2026-1-5T1:2:3Z"), ("started_at", "2026-11- 5T10:15:00Z"),
            ("started_at", "\u0662\u0660\u0662\u0666-11-27T10:15:00Z"), ("started_at", "2026-11-27T10:15:00Z\n"),
            ("started_at", "2026-11-27 10:15:00"), ("started_at", "2026-13-40T10:15:00Z"), ("started_at", 5),
            ("finished_at", "yesterday"),
            ("duration_seconds", -1), ("duration_seconds", 1_000_001), ("duration_seconds", True),
            ("duration_seconds", 1.5), ("duration_seconds", None),
            ("model", "x" * 101), ("model", 7), ("model", "bad\x00name"), ("model", "lone\ud800"),
            ("model", "has space"),
            ("turns", -1), ("turns", 100_001), ("turns", False), ("turns", "3"),
            ("resets_at", 4_102_444_801), ("resets_at", -1), ("resets_at", "soon"), ("resets_at", 1.5), ("resets_at", True),
        )
        for key, value in rows:
            with self.subTest(key=key, value=value):
                problems = validate_run({**run_record(job), key: value})
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(key, problems[0])

    def test_validate_run_accepts_the_boundary_values(self):
        job = new_job_id("fix_issue", 1, NOW)
        record = {**run_record(job), "duration_seconds": 1_000_000, "turns": 100_000, "resets_at": 4_102_444_800,
                  "model": "claude-x.1:2[3]_" + "x" * 84}
        self.assertEqual(validate_run(record), [])

    def test_validate_run_requires_a_reason_for_refused_and_crashed(self):
        job = new_job_id("fix_issue", 1, NOW)
        for status in ("refused", "crashed"):
            self.assertEqual(len(validate_run({**run_record(job), "status": status, "reason": None})), 1)
            self.assertEqual(validate_run({**run_record(job), "status": status, "reason": "firewall"}), [])

    def test_validate_run_reports_missing_and_unknown_keys_together(self):
        record = run_record(new_job_id("fix_issue", 1, NOW))
        del record["model"], record["turns"]
        record["surprise"] = 1
        self.assertEqual(len(validate_run(record)), 3)

    def test_validate_run_never_raises_on_a_wrongly_shaped_input(self):
        for data in (None, [], "text", 5, True, {}, {"schema": [], "job_id": {}, "status": []}):
            self.assertTrue(validate_run(data))


class PruneTest(SpoolTestCase):
    def closed_job(self, spool: Spool, issue: int, closed_at: datetime) -> str:
        job = new_job_id("fix_issue", issue, NOW - timedelta(days=100))
        spool.submit(job, {"request.json": b"{}"})
        spool.close(job, "published", closed_at)
        return job

    def test_prune_removes_only_old_closed_jobs(self):
        spool = self.ready()
        old = self.closed_job(spool, 1, NOW - timedelta(days=15))
        recent = self.closed_job(spool, 2, NOW - timedelta(days=13))
        open_job = new_job_id("fix_issue", 3, NOW - timedelta(days=100))
        spool.submit(open_job, {"request.json": b"{}"})
        self.assertEqual(spool.prune("dispatcher", NOW), [old])
        self.assertEqual(spool.job_ids(), sorted([recent, open_job]))

    def test_prune_keeps_a_job_whose_closed_file_is_unreadable(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW - timedelta(days=100))
        spool.submit(job, {"request.json": b"{}", "closed.json": b"not json"})
        self.assertEqual(spool.prune("dispatcher", NOW), [])
        self.assertEqual(spool.job_ids(), [job])

    def test_runner_prune_removes_run_directories_whose_job_is_gone(self):
        spool = self.ready()
        kept = self.closed_job(spool, 1, NOW)
        gone = new_job_id("fix_issue", 2, NOW)
        for job in (kept, gone):
            spool.claim(job, NOW)
        (self.root / "runs" / "notes").mkdir()
        self.assertEqual(spool.prune("runner", NOW), [gone])
        self.assertEqual(sorted(p.name for p in (self.root / "runs").iterdir()), sorted([kept, "notes"]))

    def test_dispatcher_prune_removes_only_stale_incoming_directories(self):
        spool = self.ready()
        jobs = self.root / "jobs"
        stale = jobs / f".incoming-{new_job_id('fix_issue', 1, NOW)}"
        fresh = jobs / f".incoming-{new_job_id('fix_issue', 2, NOW)}"
        stale.mkdir()
        fresh.mkdir()
        old = NOW.timestamp() - 2 * 86400
        os.utime(stale, (old, old))
        os.utime(fresh, (NOW.timestamp(), NOW.timestamp()))
        self.assertEqual(spool.prune("dispatcher", NOW), [])
        self.assertEqual((stale.exists(), fresh.exists()), (False, True))

    def test_runner_prune_does_nothing_without_a_jobs_directory(self):
        spool = Spool(self.root)
        (self.root / "runs").mkdir(parents=True)
        job = new_job_id("fix_issue", 1, NOW)
        (self.root / "runs" / job).mkdir()
        self.assertEqual(spool.prune("runner", NOW), [])
        self.assertTrue((self.root / "runs" / job).exists())

    def test_prune_refuses_an_unknown_side(self):
        with self.assertRaises(SpoolError):
            Spool(self.root).prune("someone", NOW)


if __name__ == "__main__":
    unittest.main()

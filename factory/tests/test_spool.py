"""Tests for the spool directory shared by the dispatcher and the runner."""

import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from factory.spool import MAX_RECORD_BYTES, Spool, SpoolError, new_job_id, read_bounded, validate_run

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
        self.assertEqual(spool.run_file(job, "result.json").read_bytes(), b"{}")
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
            lambda: spool.job_file(bad, "a"), lambda: spool.run_file(bad, "a"),
            lambda: spool.close(bad, "r", NOW), lambda: spool.claim(bad, NOW),
            lambda: spool.finish(bad, {}, {}), lambda: spool.run_record(bad),
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
                spool.run_file(job, bad)

    def test_finish_writes_run_json_last_and_leaves_no_temporary_file(self):
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        spool.claim(job, NOW)
        missing = self.tmp / "absent.bundle"
        with self.assertRaises(OSError):
            spool.finish(job, run_record(job), {"commits.bundle": missing})
        self.assertEqual(spool.state(job), "running")
        spool.finish(job, run_record(job), {"commits.bundle": self.file(b"B")})
        self.assertEqual(sorted(p.name for p in (self.root / "runs" / job).iterdir()),
                         ["claimed.json", "commits.bundle", "run.json"])

    def test_prepare_refuses_an_unknown_side(self):
        with self.assertRaises(SpoolError):
            Spool(self.root).prepare("someone")

    @unittest.skipUnless(os.name == "posix", "directory modes only have an effect on POSIX")
    def test_prepare_applies_the_group_readable_setgid_mode(self):
        self.ready()
        self.assertEqual(os.stat(self.root / "jobs").st_mode & 0o7777, 0o2750)
        self.assertEqual(os.stat(self.root / "runs").st_mode & 0o7777, 0o2750)


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
        with self.assertRaises(SpoolError):
            read_bounded(self.tmp, 100)
        with self.assertRaises(SpoolError):
            read_bounded(self.tmp / "absent", 100)
        with self.assertRaises(SpoolError):
            read_bounded(self.file(b"abcd"), 3)

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
    def finished(self, record: object) -> tuple[Spool, str]:
        spool = self.ready()
        job = new_job_id("fix_issue", 1, NOW)
        spool.submit(job, {"request.json": b"{}"})
        spool.claim(job, NOW)
        (self.root / "runs" / job / "run.json").write_text(json.dumps(record))
        return spool, job

    def test_run_record_rejects_an_unknown_status_and_an_unknown_key(self):
        job = new_job_id("fix_issue", 1, NOW)
        for change in ({"status": "exploded"}, {"extra": 1}):
            spool, job = self.finished({**run_record(job), **change})
            with self.assertRaises(SpoolError):
                spool.run_record(job)

    def test_run_record_rejects_an_oversized_file(self):
        spool, job = self.finished({**run_record(new_job_id("fix_issue", 1, NOW)), "model": "x" * MAX_RECORD_BYTES})
        with self.assertRaises(SpoolError):
            spool.run_record(job)

    def test_run_record_rejects_text_that_is_not_json_or_not_an_object(self):
        spool, job = self.finished([1, 2])
        with self.assertRaises(SpoolError):
            spool.run_record(job)
        (self.root / "runs" / job / "run.json").write_bytes(b"\xff\xfe not json")
        with self.assertRaises(SpoolError):
            spool.run_record(job)

    def test_validate_run_accepts_a_valid_record(self):
        self.assertEqual(validate_run(run_record(new_job_id("fix_issue", 1, NOW))), [])

    def test_validate_run_has_a_row_per_rule(self):
        job = new_job_id("fix_issue", 1, NOW)
        rows = (
            ("schema", 2), ("schema", True), ("job_id", "nope"), ("job_id", None),
            ("status", "bad"), ("status", 1),
            ("reason", "bad"), ("reason", 3),
            ("started_at", "2026-11-27 10:15:00"), ("started_at", "2026-13-40T10:15:00Z"), ("started_at", 5),
            ("finished_at", "yesterday"),
            ("duration_seconds", -1), ("duration_seconds", 1_000_001), ("duration_seconds", True),
            ("duration_seconds", 1.5), ("duration_seconds", None),
            ("model", "x" * 101), ("model", 7),
            ("turns", -1), ("turns", 100_001), ("turns", False), ("turns", "3"),
            ("resets_at", "soon"), ("resets_at", 1.5), ("resets_at", True),
        )
        for key, value in rows:
            with self.subTest(key=key, value=value):
                problems = validate_run({**run_record(job), key: value})
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(key, problems[0])

    def test_validate_run_accepts_the_boundary_values(self):
        job = new_job_id("fix_issue", 1, NOW)
        record = {**run_record(job), "duration_seconds": 1_000_000, "turns": 100_000, "resets_at": 1_800_000_000,
                  "model": "x" * 100}
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

    def test_prune_refuses_an_unknown_side(self):
        with self.assertRaises(SpoolError):
            Spool(self.root).prune("someone", NOW)


if __name__ == "__main__":
    unittest.main()

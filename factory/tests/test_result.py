"""Tests for validation of the result file an agent writes."""

import json
import tempfile
import unittest
from pathlib import Path

from factory.result import MAX_RESULT_BYTES, ResultError, load, validate

VERIFICATION = [{"command": "make check", "exit_code": 0, "summary": "passed"}]
PULL_REQUEST = {"title": "Add thing", "body": "Adds the thing."}


def done(**extra) -> dict:
    data = {"schema": 1, "outcome": "done", "summary": "Did it.", "verification": VERIFICATION,
            "pull_request": PULL_REQUEST}
    data.update(extra)
    return data


class ResultTest(unittest.TestCase):
    def mentions(self, data: object, stage: str, text: str):
        problems = validate(data, stage)
        self.assertTrue(any(text in p for p in problems), problems)

    def test_done_step_result_is_valid(self):
        self.assertEqual(validate(done(), "step"), [])
        self.assertEqual(validate(done(follow_ups=[{"title": "t", "reason": "r"}]), "step"), [])

    def test_needs_input_requires_questions(self):
        data = {"schema": 1, "outcome": "needs_input", "summary": "Stuck."}
        self.mentions(data, "step", "questions")
        self.assertEqual(validate({**data, "questions": ["Which one?"]}, "step"), [])
        self.mentions(done(questions=["x"]), "step", "questions")

    def test_failed_requires_reason(self):
        data = {"schema": 1, "outcome": "failed", "summary": "Broke."}
        self.mentions(data, "step", "failure_reason")
        self.assertEqual(validate({**data, "failure_reason": "Tests fail."}, "step"), [])
        self.mentions(done(failure_reason="x"), "step", "failure_reason")

    def test_done_requires_pull_request_except_for_revise_and_fix(self):
        without = done()
        del without["pull_request"]
        for stage in ("design", "plan", "step", "fix_issue"):
            with self.subTest(stage):
                self.mentions(without, stage, "pull_request")
        for stage in ("revise", "fix"):
            with self.subTest(stage):
                self.assertEqual(validate(without, stage), [])

    def test_done_requires_verification(self):
        self.mentions(done(verification=[]), "step", "verification")

    def test_thread_replies_only_for_revise(self):
        replies = [{"thread_id": "T1", "body": "Fixed.", "resolved": True}]
        self.assertEqual(validate(done(thread_replies=replies), "revise"), [])
        self.mentions(done(thread_replies=replies), "step", "thread_replies")
        self.mentions(done(thread_replies=[{"thread_id": "T1", "body": "", "resolved": "yes"}]), "revise",
                      "thread_replies[0]")

    def test_unknown_key_rejected(self):
        self.mentions(done(extra=1), "step", "extra")

    def test_bad_stage_outcome_and_schema(self):
        self.mentions(done(), "bogus", "stage")
        self.mentions(done(outcome="maybe"), "step", "outcome")
        self.mentions(done(schema=2), "step", "schema")

    def test_length_limits(self):
        self.mentions(done(summary="x" * 4001), "step", "summary")
        self.mentions(done(pull_request={"title": "x" * 121, "body": "b"}), "step", "pull_request.title")
        self.mentions(done(follow_ups=[{"title": "t", "reason": "r"}] * 11), "step", "follow_ups")

    def test_oversized_file_rejected_before_parsing(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "result.json"
            path.write_bytes(b"x" * (MAX_RESULT_BYTES + 1))
            with self.assertRaises(ResultError) as ctx:
                load(path, "step")
            self.assertIn(str(MAX_RESULT_BYTES), " ".join(ctx.exception.problems))

    def test_load_reads_valid_file_and_rejects_bad_ones(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "result.json"
            path.write_text(json.dumps(done()), encoding="utf-8")
            self.assertEqual(load(path, "step")["outcome"], "done")
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaises(ResultError):
                load(path, "step")
            with self.assertRaises(ResultError):
                load(Path(tmp) / "missing.json", "step")
            path.write_text(json.dumps({"schema": 1}), encoding="utf-8")
            with self.assertRaises(ResultError) as ctx:
                load(path, "step")
            self.assertTrue(ctx.exception.problems)

    def test_deeply_nested_file_is_a_result_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "result.json"
            path.write_text("[" * 150_000, encoding="utf-8")
            with self.assertRaises(ResultError) as ctx:
                load(path, "step")
            self.assertTrue(ctx.exception.problems)

    def test_non_object_and_wrong_types_do_not_raise(self):
        hostile = {"schema": 1, "outcome": "done", "summary": "s", "verification": "no",
                   "pull_request": [], "follow_ups": {}, "questions": 3}
        for data in (None, [], "x", 5, {"summary": 5}, hostile):
            with self.subTest(data=data):
                self.assertTrue(validate(data, "step"))


if __name__ == "__main__":
    unittest.main()

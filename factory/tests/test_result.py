"""Tests for validation of the result file an agent writes."""

import json
import re
import tempfile
import unittest
from pathlib import Path

from factory import hygiene
from factory.config import load as load_config
from factory.result import MAX_RESULT_BYTES, OUTCOMES, ResultError, load, posted_texts, validate

VERIFICATION = [{"command": "make check", "exit_code": 0, "summary": "passed"}]
PULL_REQUEST = {"title": "Add thing", "body": "Adds the thing."}
CONTRACT = Path(__file__).resolve().parents[1] / "AGENT_CONTRACT.md"
JSON_FENCE = re.compile(r"^```json\n(.*?)^```", re.MULTILINE | re.DOTALL)
STAGE_COMMENT = re.compile(r"<!-- stage: (\w+) -->")


def contract_examples() -> list[tuple[str | None, str]]:
    """Each fenced json block of the agent contract, with the stage its preceding comment names, or None."""
    text = CONTRACT.read_text(encoding="utf-8")
    examples = []
    for fence in JSON_FENCE.finditer(text):
        line_before = text[:fence.start()].rstrip().rpartition("\n")[2].strip()
        stage = STAGE_COMMENT.fullmatch(line_before)
        examples.append((stage.group(1) if stage else None, fence.group(1)))
    return examples


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

    def test_failure_reason_and_questions_are_bounded(self):
        failed = {"schema": 1, "outcome": "failed", "summary": "Broke."}
        self.assertEqual(validate({**failed, "failure_reason": "x" * 4000}, "step"), [])
        self.mentions({**failed, "failure_reason": "x" * 4001}, "step", "failure_reason")
        asking = {"schema": 1, "outcome": "needs_input", "summary": "Stuck."}
        self.assertEqual(validate({**asking, "questions": ["q" * 2000] * 20}, "step"), [])
        self.mentions({**asking, "questions": ["q"] * 21}, "step", "questions: at most 20")
        self.mentions({**asking, "questions": ["q" * 2001]}, "step", "questions[0]")
        self.mentions({**asking, "questions": [""]}, "step", "questions")

    def test_every_posted_text_must_hold_a_printable_character_that_is_not_white_space(self):
        blank = ("   ", "\x01\t\x7f", "​ ", "\n\n")
        asking = {"schema": 1, "outcome": "needs_input", "summary": "Stuck."}
        failed = {"schema": 1, "outcome": "failed", "summary": "Broke."}
        for text in blank:
            cases = {
                "summary": (done(summary=text), "step"),
                "questions[1]": ({**asking, "questions": ["Which?", text]}, "step"),
                "failure_reason": ({**failed, "failure_reason": text}, "step"),
                "pull_request.title": (done(pull_request={"title": text, "body": "b"}), "step"),
                "pull_request.body": (done(pull_request={"title": "t", "body": text}), "step"),
                "follow_ups[0].title": (done(follow_ups=[{"title": text, "reason": "r"}]), "step"),
                "follow_ups[0].reason": (done(follow_ups=[{"title": "t", "reason": text}]), "step"),
            }
            for field, (data, stage) in cases.items():
                with self.subTest(field=field, text=text):
                    problems = validate(data, stage)
                    self.assertTrue(any(problem.startswith(f"{field}: ") for problem in problems), problems)
        self.assertEqual(validate(done(summary=" ​. ", pull_request={"title": "\tA", "body": "b\n"}), "step"), [])

    def test_verification_is_bounded(self):
        entry = {"command": "c" * 500, "exit_code": 0, "summary": "s" * 2000}
        self.assertEqual(validate(done(verification=[entry] * 30), "step"), [])
        self.mentions(done(verification=[entry] * 31), "step", "verification: at most 30")
        self.mentions(done(verification=[{**entry, "command": "c" * 501}]), "step", "verification[0].command")
        self.mentions(done(verification=[{**entry, "command": ""}]), "step", "verification[0].command")
        self.mentions(done(verification=[{**entry, "summary": "s" * 2001}]), "step", "verification[0].summary")
        self.assertEqual(validate(done(verification=[{**entry, "summary": ""}]), "step"), [])

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


class ContractTest(unittest.TestCase):
    def test_the_contract_states_what_the_dispatcher_refuses_with_the_configured_limits(self):
        text = CONTRACT.read_text(encoding="utf-8")
        section = text.partition("## What the dispatcher refuses\n")[2].partition("\n## ")[0]
        limits = load_config().dispatcher
        for words in (f"{limits.max_commits} commits", f"{limits.max_file_megabytes} MB",
                      f"{limits.max_bundle_megabytes} MB", "2,000", "`apps/`", "`packages/`", "commit message",
                      "`#<issue>`", "file names", "verification"):
            with self.subTest(words=words):
                self.assertIn(words, section)

    def test_contract_examples_are_valid(self):
        examples = contract_examples()
        self.assertGreaterEqual(len(examples), 4, "the contract needs an example per outcome and one for revise")
        outcomes = set()
        for index, (stage, block) in enumerate(examples):
            with self.subTest(example=index + 1, stage=stage):
                self.assertIsNotNone(stage, "put <!-- stage: <stage> --> on the line before the example's fence")
                example = json.loads(block)
                self.assertEqual(validate(example, stage), [])
                outcomes.add(example["outcome"])
        self.assertEqual(outcomes, set(OUTCOMES))


class PostedTextsTests(unittest.TestCase):
    def test_every_reply_to_a_thread_is_listed_under_the_name_of_its_entry(self) -> None:
        data = {"schema": 1, "outcome": "done", "summary": "Done.", "verification": VERIFICATION,
                "thread_replies": [{"thread_id": "T1", "body": "First.", "resolved": True},
                                   {"thread_id": "T2", "body": "Second.", "resolved": False}]}
        self.assertEqual([], validate(data, "revise"))
        listed = dict(posted_texts(data))
        self.assertEqual(("First.", "Second."), (listed["thread_replies[0].body"], listed["thread_replies[1].body"]))

    def test_a_reply_that_names_a_home_directory_is_a_finding_the_finish_check_can_report(self) -> None:
        home = "/" + "home/someone/project"  # joined at run time: the repository checker refuses the literal
        data = {"schema": 1, "outcome": "done", "summary": "Done.", "verification": VERIFICATION,
                "thread_replies": [{"thread_id": "T1", "body": f"Look at {home}.", "resolved": False}]}
        found = [(field, label) for field, text in posted_texts(data) for _, label in hygiene.text_problems(text)]
        self.assertEqual([("thread_replies[0].body", "personal filesystem path")], found)


if __name__ == "__main__":
    unittest.main()

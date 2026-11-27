"""Tests for publishing a finished run: a real spool, real git repositories and an in-memory GitHub."""

import dataclasses
import itertools
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from factory import compose, gitops, jobs, markers
from factory import config as factory_config
from factory.github_api import GitHubError
from factory.gitops import GitError
from factory.publish import Publisher
from factory.result import MAX_RESULT_BYTES
from factory.snapshot import Bot, Comment, Issue
from factory.spool import Spool, SpoolError, new_job_id
from factory.tests.fakes import FIRST_NUMBER, FakeGitHub
from factory.tests.gitrepo import Repo

CONFIG = factory_config.load()
BOT = Bot("factory-test[bot]", 4242)
BRANCH = "factory/fix-12"
NOW = datetime(2026, 11, 27, 10, 15, 0, tzinfo=timezone.utc)
KEY = "sk-" + "a" * 24
TOKEN = "token-" + "x" * 20
PERSONAL_PATH = "/" + "home/someone/project"  # joined at run time: the repository checker refuses the literal
PRIVATE_ADDRESS = "10.0." + "0.5"
BASE_FILES = {"README.md": "# Demo\n", "apps/demo/a.txt": "old\n"}
GOOD_CHANGE = {"apps/demo/a.txt": "new\n"}
PROTECTED_CHANGE = {"README.md": "changed\n"}
ISSUE = Issue(
    number=12, title="Fix the greeting", body="It says helo.", author="Marfusios", open=True,
    labels=("factory:fix", "status:building"), trigger_actor="Marfusios", comments=(), pull_request=None,
)
OPEN_PULLS = {"head": "owner:factory/fix-12", "state": "open", "per_page": "10"}
ALL_COMMENTS = {"per_page": "100"}


def key(path: str, params: dict) -> tuple:
    return (path, tuple(sorted(params.items())))


def limits(**changes: int) -> factory_config.Config:
    return dataclasses.replace(CONFIG, dispatcher=dataclasses.replace(CONFIG.dispatcher, **changes))


def run_record(job: str, status: str, reason: str | None, resets_at: int | None, model: str) -> dict:
    return {
        "schema": 1, "job_id": job, "status": status, "reason": reason, "started_at": "2026-11-27T10:00:00Z",
        "finished_at": "2026-11-27T10:12:05Z", "duration_seconds": 725, "model": model, "turns": 12,
        "resets_at": resets_at,
    }


def done_result(**changes) -> dict:
    return {
        "schema": 1, "outcome": "done", "summary": "The greeting now says hello.",
        "pull_request": {"title": "Fix the greeting", "body": "Spell hello right."},
        "verification": [{"command": "make check", "exit_code": 0, "summary": "all tests passed"}],
        **changes,
    }


def needs_input_result(**changes) -> dict:
    return {
        "schema": 1, "outcome": "needs_input", "summary": "Two greetings are possible.",
        "questions": ["Which greeting should it use?"], **changes,
    }


def failed_result(**changes) -> dict:
    return {
        "schema": 1, "outcome": "failed", "summary": "Could not run the tests.",
        "failure_reason": "The test runner does not start.", **changes,
    }


def comment_json(comment_id: int, login: str, user_id: int, body: str) -> dict:
    return {"id": comment_id, "user": {"login": login, "id": user_id}, "created_at": "2026-11-27T09:00:00Z",
            "body": body}


def stamp(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


class PublishTestCase(unittest.TestCase):
    def setUp(self):
        self.build()

    def build(self, config: factory_config.Config = CONFIG) -> None:
        """A fresh world: an upstream repository, the dispatcher's mirror and work repository, the remote that
        stands in for GitHub's repository, a spool with one job for issue 12, and an empty GitHub."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.numbers = itertools.count(1)
        self.upstream = Repo(self.tmp / "upstream")
        self.base = self.upstream.commit(BASE_FILES)
        mirror = self.upstream.bare_clone(self.tmp / "mirror.git")
        self.remote = self.upstream.bare_clone(self.tmp / "remote.git")
        self.workrepo = self.tmp / "work.git"
        gitops.ensure_workrepo(self.workrepo, mirror)
        self.spool = Spool(self.tmp / "spool")
        self.spool.prepare("dispatcher")
        self.github = FakeGitHub(user={"login": BOT.login, "id": BOT.user_id})
        self.pulls = f"{self.github.repo}/pulls"
        self.comments = f"{self.github.repo}/issues/12/comments"
        self.labels = f"{self.github.repo}/issues/12/labels"
        self.github.answers[key(self.pulls, OPEN_PULLS)] = []
        self.github.answers[key(self.comments, ALL_COMMENTS)] = []
        self.scratch = self.tmp / "scratch"
        self.publisher = Publisher(
            spool=self.spool, github=self.github, config=config, bot=BOT, workrepo=self.workrepo,
            scratch=self.scratch, push_url=str(self.remote), token=lambda: TOKEN,
        )
        self.job = self.new_job()

    def new_job(self) -> str:
        job = new_job_id("fix_issue", 12, NOW)
        request = jobs.request_file(job_id=job, stage="fix_issue", app="demo", branch=BRANCH, base_sha=self.base,
                                    repository="owner/name", config=CONFIG, bot=BOT)
        self.spool.submit(job, {"request.json": json.dumps(request).encode("utf-8")})
        return job

    def bundle_of(self, *commits: dict) -> Path:
        """Commits by the bot on the work branch from the base, bundled as the runner hands them over."""
        self.upstream.switch(BRANCH, self.base)
        for files in commits:
            self.upstream.commit(files, name=BOT.login, email=BOT.email)
        self.work_head = self.upstream.head
        return self.upstream.bundle(self.base, BRANCH, self.tmp / f"commits-{next(self.numbers)}.bundle")

    def finish(self, job: str | None = None, *, status: str = "completed", reason: str | None = None,
               resets_at: int | None = None, model: str = "some-model", result: dict | bytes | None = None,
               bundle: Path | None = None) -> str:
        """Hand the job back as the runner does: the result (an object as JSON, or raw bytes), the bundle, run.json."""
        job = job or self.job
        self.spool.claim(job, NOW)
        files = {}
        if result is not None:
            path = self.tmp / f"result-{next(self.numbers)}.json"
            path.write_bytes(result if isinstance(result, bytes) else json.dumps(result).encode("utf-8"))
            files["result.json"] = path
        if bundle is not None:
            files["commits.bundle"] = bundle
        self.spool.finish(job, run_record(job, status, reason, resets_at, model), files)
        return job

    def publish(self, job: str | None = None, issue: Issue = ISSUE) -> str:
        return self.publisher.publish(job or self.job, issue, NOW)

    def writes(self, method: str, path: str) -> list:
        return [body for called_method, called, body in self.github.calls if (called_method, called) == (method, path)]

    def comment(self) -> str:
        """The body of the one run comment that was posted."""
        posted = self.writes("POST", self.comments)
        self.assertEqual(len(posted), 1, posted)
        return posted[0]["body"]

    def remote_branch(self) -> str | None:
        return gitops.resolve(self.remote, f"refs/heads/{BRANCH}")

    def assertNeedsAPerson(self) -> None:
        self.assertIn(("DELETE", f"{self.labels}/status%3Abuilding", None), self.github.calls)
        self.assertEqual(self.github.posted(self.labels), {"labels": ["status:needs-human"]})
        self.assertEqual(self.spool.state(self.job), "closed")

    def assertNothingPrivateWritten(self) -> None:
        written = json.dumps([body for _, _, body in self.github.calls])
        self.assertNotIn(TOKEN, written)
        self.assertNotIn(self.tmp.name, written)


class DoneTest(PublishTestCase):
    def test_a_done_run_pushes_opens_a_draft_pull_request_and_comments(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        outcome = self.publisher.publish(self.job, ISSUE, NOW)
        self.assertEqual(outcome, "done")
        self.assertEqual(gitops.resolve(self.remote, "refs/heads/factory/fix-12"), self.work_head)
        created = self.github.posted(f"{self.github.repo}/pulls")
        self.assertEqual((created["draft"], created["base"], created["head"]), (True, "main", "factory/fix-12"))
        self.assertTrue(created["body"].endswith("\nCloses #12"))
        comment = self.github.posted(f"{self.github.repo}/issues/12/comments")
        self.assertEqual(markers.parse(comment["body"])["outcome"], "done")
        self.assertEqual(self.spool.state(self.job), "closed")

        self.assertEqual(created["title"], compose.pull_request_title("Fix the greeting"))
        pull_request_labels = self.github.posted(f"{self.github.repo}/issues/{FIRST_NUMBER}/labels")
        self.assertEqual(pull_request_labels, {"labels": ["stage:fix"]})
        body = self.comment()
        self.assertIn("The greeting now says hello.", body)
        self.assertIn(f"Pull request: https://github.com/owner/name/pull/{FIRST_NUMBER}", body)
        self.assertEqual(self.github.posted(self.labels), {"labels": ["status:building"]})
        self.assertEqual(json.loads(self.spool.job_file(self.job, "closed.json").read_text())["reason"], "done")
        self.assertNothingPrivateWritten()

    def test_an_open_pull_request_is_updated_and_not_opened_again(self):
        self.github.answers[key(self.pulls, OPEN_PULLS)] = [
            {"number": 7, "state": "open", "html_url": "https://example.test/pull/7"},
        ]
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.assertEqual(self.publish(), "done")
        self.assertEqual(self.writes("POST", self.pulls), [])
        [patched] = self.writes("PATCH", f"{self.pulls}/7")
        self.assertEqual(patched["title"], compose.pull_request_title("Fix the greeting"))
        self.assertTrue(patched["body"].endswith("\nCloses #12"))
        self.assertEqual(self.github.posted(f"{self.github.repo}/issues/7/labels"), {"labels": ["stage:fix"]})
        # GitHub's link has an unexpected shape, so the comment links the pull request it builds itself.
        self.assertIn("Pull request: https://github.com/owner/name/pull/7", self.comment())

    def test_publishing_twice_after_each_possible_interruption_leaves_one_of_everything(self):
        for failing in ("pulls", f"issues/{FIRST_NUMBER}/labels", "issues/12/comments", "issues/12/labels"):
            with self.subTest(failing=failing):
                self.build()
                self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
                self.github.fail_once.add(f"{self.github.repo}/{failing}")
                with self.assertRaises(GitHubError):
                    self.publish()
                self.assertEqual(self.spool.state(self.job), "finished")
                self.assertEqual(self.publish(), "done")
                self.assertEqual(self.remote_branch(), self.work_head)
                self.assertEqual(len(self.writes("POST", self.pulls)), 1)
                self.assertEqual(len(self.writes("POST", self.comments)), 1)
                self.assertEqual(self.spool.state(self.job), "closed")

    def test_a_failure_on_the_status_label_leaves_the_job_open_and_the_repeat_adds_nothing_twice(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.github.fail_once.add(self.labels)
        with self.assertRaises(GitHubError):
            self.publish()
        self.assertEqual(self.spool.state(self.job), "finished")
        self.assertEqual((len(self.writes("POST", self.pulls)), len(self.writes("POST", self.comments))), (1, 1))
        self.assertEqual(self.publish(), "done")
        self.assertEqual((len(self.writes("POST", self.pulls)), len(self.writes("POST", self.comments))), (1, 1))
        self.assertEqual(self.github.posted(self.labels), {"labels": ["status:building"]})
        self.assertEqual(self.spool.state(self.job), "closed")

    def test_a_failed_push_writes_nothing_to_github_and_leaves_the_job_finished(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        unreachable = dataclasses.replace(self.publisher, push_url=str(self.tmp / "no-such-remote.git"))
        with self.assertRaises(GitError) as raised:
            unreachable.publish(self.job, ISSUE, NOW)
        self.assertNotIn(TOKEN, str(raised.exception))
        self.assertNotIn(self.tmp.name, str(raised.exception))
        self.assertEqual(self.github.calls, [])
        self.assertEqual(self.spool.state(self.job), "finished")
        self.assertEqual(self.publish(), "done")
        self.assertEqual(self.remote_branch(), self.work_head)

    def test_a_clean_up_failure_does_not_undo_a_publication(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        real_git = gitops.run_git

        def refuse_to_delete_refs(repo, *args, **options):
            if "update-ref" in args:
                raise GitError("update-ref", 1)
            return real_git(repo, *args, **options)

        with mock.patch("factory.gitops.run_git", side_effect=refuse_to_delete_refs):
            self.assertEqual(self.publish(), "done")
        self.assertEqual(self.spool.state(self.job), "closed")

    def test_a_request_that_is_not_what_the_dispatcher_wrote_stops_before_anything_is_written(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        request = self.spool.request(self.job)
        self.spool.job_file(self.job, "request.json").write_text(json.dumps({**request, "base_sha": "main"}))
        with self.assertRaises(SpoolError) as raised:
            self.publish()
        self.assertIn("base_sha is not acceptable", str(raised.exception))
        self.assertEqual(self.github.calls, [])
        self.assertEqual(self.spool.state(self.job), "finished")

    def test_a_bundle_that_cannot_be_copied_stops_without_naming_a_host_path(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.scratch.write_text("a file where the scratch directory belongs")
        with self.assertRaises(SpoolError) as raised:
            self.publish()
        self.assertIn("commits.bundle cannot be copied for checking", str(raised.exception))
        self.assertNotIn(self.tmp.name, str(raised.exception))
        self.assertEqual(self.github.calls, [])
        self.assertIsNone(self.remote_branch())
        self.assertEqual(self.spool.state(self.job), "finished")

    def test_a_naive_clock_is_refused_before_anything_is_written(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        with self.assertRaises(ValueError):
            self.publisher.publish(self.job, ISSUE, NOW.replace(tzinfo=None))
        self.assertEqual(self.github.calls, [])
        self.assertIsNone(self.remote_branch())
        self.assertEqual(self.spool.state(self.job), "finished")


class NeedsInputTest(PublishTestCase):
    def test_needs_input_keeps_checked_commits_on_the_branch_without_a_pull_request(self):
        self.finish(result=needs_input_result(), bundle=self.bundle_of(GOOD_CHANGE, {"apps/demo/b.txt": "b\n"}))
        self.assertEqual(self.publish(), "needs_input")
        self.assertEqual(self.remote_branch(), self.work_head)
        self.assertEqual([call for call in self.github.calls if call[1].startswith(self.pulls)], [])
        body = self.comment()
        self.assertEqual(markers.parse(body)["outcome"], "needs_input")
        self.assertIn("1. Which greeting should it use?", body)
        self.assertIn("The work so far is on the branch", body)
        self.assertNeedsAPerson()

    def test_needs_input_with_a_bad_bundle_posts_the_questions_and_says_the_work_was_not_kept(self):
        cases = {
            "a protected path": (CONFIG, PROTECTED_CHANGE, "README.md, which is outside the writable paths"),
            "a bundle over the limit": (limits(max_bundle_megabytes=1), None,
                                        "the bundle is missing or larger than 1 MB"),
        }
        for name, (config, change, problem) in cases.items():
            with self.subTest(name):
                self.build(config)
                bundle = self.bundle_of(change) if change else self.tmp / "big.bundle"
                if change is None:
                    bundle.write_bytes(b"x" * 1_000_001)
                self.finish(result=needs_input_result(), bundle=bundle)
                self.assertEqual(self.publish(), "needs_input")
                self.assertIsNone(self.remote_branch())
                body = self.comment()
                self.assertIn("1. Which greeting should it use?", body)
                self.assertIn("- the work so far was not kept", body)
                self.assertIn(problem, body)
                self.assertNotIn("The work so far is on the branch", body)
                self.assertNeedsAPerson()

    def test_needs_input_without_a_bundle_only_asks(self):
        self.finish(result=needs_input_result())
        self.assertEqual(self.publish(), "needs_input")
        self.assertIsNone(self.remote_branch())
        body = self.comment()
        self.assertIn("1. Which greeting should it use?", body)
        self.assertNotIn("not kept", body)
        self.assertNotIn("The work so far is on the branch", body)
        self.assertNeedsAPerson()


class RejectionTest(PublishTestCase):
    def test_done_with_a_protected_path_is_rejected_and_nothing_is_pushed(self):
        self.finish(result=done_result(), bundle=self.bundle_of(PROTECTED_CHANGE))
        self.assertEqual(self.publish(), "rejected")
        self.assertIsNone(self.remote_branch())
        self.assertEqual(self.writes("POST", self.pulls), [])
        body = self.comment()
        self.assertEqual(markers.parse(body)["outcome"], "rejected")
        self.assertIn("README.md, which is outside the writable paths", body)
        self.assertNeedsAPerson()

    def test_done_without_a_bundle_is_rejected_for_having_no_commits(self):
        self.finish(result=done_result())
        self.assertEqual(self.publish(), "rejected")
        self.assertEqual(self.writes("POST", self.pulls), [])
        self.assertIn("- there are no commits", self.comment())
        self.assertNeedsAPerson()

    def test_the_scratch_copy_and_the_quarantine_ref_are_gone_after_a_rejected_run(self):
        self.finish(result=done_result(), bundle=self.bundle_of(PROTECTED_CHANGE))
        self.assertEqual(self.publish(), "rejected")
        self.assertIsNone(gitops.resolve(self.workrepo, f"refs/quarantine/{self.job}"))
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_a_credential_in_the_summary_blocks_publication_and_is_not_posted(self):
        self.finish(result=done_result(summary=f"Tested with the key {KEY} and {KEY[:-1]}b."),
                    bundle=self.bundle_of(GOOD_CHANGE))
        self.assertEqual(self.publish(), "rejected")
        self.assertIsNone(self.remote_branch())
        self.assertEqual(self.writes("POST", self.pulls), [])
        body = self.comment()
        self.assertEqual(markers.parse(body)["outcome"], "rejected")
        self.assertIn("- the result's text contains possible provider key", body)
        self.assertEqual(body.count("possible provider key"), 1)
        self.assertNotIn("Tested with the key", body)
        self.assertNotIn(KEY[:12], json.dumps([written for _, _, written in self.github.calls]))
        self.assertNeedsAPerson()

    def test_a_finding_in_text_that_is_never_posted_still_blocks_publication(self):
        cases = {
            "a command it ran": (done_result(verification=[
                {"command": f"cat {PERSONAL_PATH}/x", "exit_code": 0, "summary": "ok"}]), "personal filesystem path"),
            "a follow-up": (done_result(follow_ups=[
                {"title": "Move the host", "reason": f"It is at {PRIVATE_ADDRESS} now."}]), "private network address"),
            "the reason a failed run gives": (failed_result(failure_reason=f"The key {KEY} was refused."),
                                              "possible provider key"),
        }
        for name, (result, label) in cases.items():
            with self.subTest(name):
                self.build()
                self.finish(result=result, bundle=self.bundle_of(GOOD_CHANGE))
                self.assertEqual(self.publish(), "rejected")
                self.assertIsNone(self.remote_branch())
                body = self.comment()
                self.assertIn(f"- the result's text contains {label}", body)
                self.assertNotIn(result["summary"], body)
                self.assertNeedsAPerson()

    def test_an_oversized_bundle_is_rejected_without_being_copied_whole(self):
        self.build(limits(max_bundle_megabytes=1))
        oversized = self.tmp / "big.bundle"
        oversized.write_bytes(b"x" * 1_000_001)
        self.finish(result=done_result(), bundle=oversized)
        with mock.patch.object(self.spool, "read_run_file", wraps=self.spool.read_run_file) as read:
            self.assertEqual(self.publish(), "rejected")
        read.assert_any_call(self.job, "commits.bundle", 1_000_000)
        self.assertFalse(self.scratch.exists())
        self.assertIn("- the bundle is missing or larger than 1 MB", self.comment())
        self.assertNeedsAPerson()


class UnusableRunTest(PublishTestCase):
    @unittest.skipUnless(hasattr(os, "symlink"), "this platform has no symbolic links")
    def test_a_result_that_is_a_symbolic_link_is_treated_as_missing(self):
        self.finish(bundle=self.bundle_of(GOOD_CHANGE))
        target = self.tmp / "readable.json"
        target.write_text(json.dumps(done_result(summary="Read through the link.")), encoding="utf-8")
        try:
            os.symlink(target, self.spool.root / "runs" / self.job / "result.json")
        except OSError:
            self.skipTest("creating symbolic links is not permitted here")
        self.assertEqual(self.publish(), "crashed")
        self.assertIsNone(self.remote_branch())
        body = self.comment()
        self.assertIn(compose.REASON_WORDS["agent_error"], body)
        self.assertNotIn("Read through the link.", body)
        self.assertNeedsAPerson()

    def test_a_missing_unreadable_or_invalid_result_counts_as_an_agent_error(self):
        cases = {
            "missing": None,
            "not JSON": b"{not json",
            "not UTF-8": b"\xff\xfe{}",
            "too large": json.dumps(done_result()).encode("utf-8") + b" " * MAX_RESULT_BYTES,
            "invalid for the stage": {**done_result(), "verification": [], "surprise": "a key the schema lacks"},
        }
        for name, result in cases.items():
            with self.subTest(name):
                self.build()
                self.finish(result=result, bundle=self.bundle_of(GOOD_CHANGE))
                self.assertEqual(self.publish(), "crashed")
                self.assertIsNone(self.remote_branch())
                body = self.comment()
                self.assertIn(compose.REASON_WORDS["agent_error"], body)
                self.assertNotIn("verification", body)
                self.assertNotIn("surprise", body)
                self.assertNeedsAPerson()

    def test_an_unknown_run_status_counts_as_crashed(self):
        self.finish(status="exploded", result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.assertEqual(self.publish(), "crashed")
        self.assertIsNone(self.remote_branch())
        body = self.comment()
        self.assertIn(compose.REASON_WORDS["internal"], body)
        self.assertIn("model `opus`", body)  # the run record is unusable, so the model comes from the request
        self.assertNeedsAPerson()

    def test_failed_timeout_refused_post_their_words_and_need_a_person(self):
        cases = {  # every run hands over good commits, and none of them are kept
            "failed": ({"result": failed_result()}, "failed", "The test runner does not start."),
            "timeout": ({"status": "timeout"}, "timed out", "Comment `/factory retry` to run this again."),
            "refused": ({"status": "refused", "reason": "firewall"}, "not started", compose.REASON_WORDS["firewall"]),
            "crashed": ({"status": "crashed", "reason": "clone"}, "ended without a result",
                        compose.REASON_WORDS["clone"]),
        }
        for outcome, (run, words, detail) in cases.items():
            with self.subTest(outcome):
                self.build()
                self.finish(bundle=self.bundle_of(GOOD_CHANGE), **run)
                self.assertEqual(self.publish(), outcome)
                self.assertIsNone(self.remote_branch())
                self.assertEqual([call for call in self.github.calls if call[1].startswith(self.pulls)], [])
                body = self.comment()
                self.assertEqual(markers.parse(body)["outcome"], outcome)
                self.assertIn(f"**{words}**", body)
                self.assertIn(detail, body)
                self.assertNeedsAPerson()

    def test_the_model_comes_from_the_request_when_the_run_names_none(self):
        self.finish(status="timeout", model="")
        self.assertEqual(self.publish(), "timeout")
        self.assertIn("model `opus`", self.comment())


class UsageLimitTest(PublishTestCase):
    def test_usage_limit_posts_once_then_updates_the_same_comment(self):
        resets = NOW + timedelta(hours=2)
        self.finish(status="usage_limit", resets_at=int(resets.timestamp()))
        self.assertEqual(self.publish(), "usage_limit")
        self.assertEqual(markers.parse(self.comment())["retry_at"], "2026-11-27T12:15:00Z")
        self.assertIn(("DELETE", f"{self.labels}/status%3Abuilding", None), self.github.calls)
        self.assertEqual(self.github.posted(self.labels), {"labels": ["status:queued"]})
        self.assertEqual(self.spool.state(self.job), "closed")
        [first] = self.github.get_all(self.comments, ALL_COMMENTS)

        later = int((resets + timedelta(hours=1)).timestamp())
        second = self.finish(self.new_job(), status="usage_limit", resets_at=later)
        self.assertEqual(self.publisher.publish(second, ISSUE, NOW), "usage_limit")
        self.assertEqual(len(self.writes("POST", self.comments)), 1)
        [patched] = self.writes("PATCH", f"{self.github.repo}/issues/comments/{first['id']}")
        self.assertEqual(markers.parse(patched["body"]), {
            "kind": "run", "job": second, "stage": "fix_issue", "outcome": "usage_limit",
            "retry_at": "2026-11-27T13:15:00Z",
        })
        self.assertEqual(self.spool.state(second), "closed")

    def test_a_usage_limit_after_another_outcome_is_a_new_comment(self):
        earlier = compose.run_comment(job_id=new_job_id("fix_issue", 12, NOW), stage="fix_issue",
                                      outcome="needs_input", duration_seconds=60, model="opus", questions=["Which?"])
        self.github.answers[key(self.comments, ALL_COMMENTS)] = [comment_json(5, BOT.login, BOT.user_id, earlier)]
        self.finish(status="usage_limit", resets_at=None)
        self.assertEqual(self.publish(), "usage_limit")
        self.assertEqual(markers.parse(self.comment())["job"], self.job)
        self.assertEqual([call for call in self.github.calls if call[0] == "PATCH"], [])

    def test_usage_limit_retry_time_falls_back_when_resets_at_is_absurd(self):
        fallback = stamp(NOW + timedelta(minutes=45))
        cases = {
            "no reset time": (None, fallback),
            "a reset in the past": (NOW - timedelta(hours=1), fallback),
            "a reset right now": (NOW, fallback),
            "a reset more than eight days ahead": (NOW + timedelta(days=8, seconds=1), fallback),
            "a reset at the end of the range": (datetime(2100, 1, 1, tzinfo=timezone.utc), fallback),
            "a reset eight days ahead": (NOW + timedelta(days=8), stamp(NOW + timedelta(days=8))),
            "a reset in a minute": (NOW + timedelta(minutes=1), stamp(NOW + timedelta(minutes=1))),
        }
        for name, (resets, expected) in cases.items():
            with self.subTest(name):
                self.build(limits(usage_limit_backoff_minutes=45))
                self.finish(status="usage_limit", resets_at=None if resets is None else int(resets.timestamp()))
                self.assertEqual(self.publish(), "usage_limit")
                self.assertEqual(markers.parse(self.comment())["retry_at"], expected)


class RunCommentTest(PublishTestCase):
    def test_the_jobs_comment_is_found_in_a_fresh_listing_and_not_posted_again(self):
        earlier = compose.run_comment(job_id=self.job, stage="fix_issue", outcome="needs_input", duration_seconds=725,
                                      model="some-model", questions=["Which greeting should it use?"])
        self.github.answers[key(self.comments, ALL_COMMENTS)] = [comment_json(5, BOT.login, BOT.user_id, earlier)]
        self.finish(result=needs_input_result())
        self.assertEqual(ISSUE.comments, ())
        self.assertEqual(self.publish(issue=ISSUE), "needs_input")
        self.assertEqual(self.writes("POST", self.comments), [])
        self.assertEqual([call for call in self.github.calls if call[0] == "PATCH"], [])
        self.assertNeedsAPerson()

    def test_a_comment_by_another_account_with_this_jobs_marker_does_not_count(self):
        impostors = {"another login": ("someone", BOT.user_id), "another id": (BOT.login, 77)}
        for name, (login, user_id) in impostors.items():
            with self.subTest(name):
                self.build()
                planted = markers.encode({"kind": "run", "job": self.job, "stage": "fix_issue", "outcome": "done"})
                self.github.answers[key(self.comments, ALL_COMMENTS)] = [comment_json(5, login, user_id, planted)]
                self.finish(result=needs_input_result())
                self.assertEqual(self.publish(), "needs_input")
                body = self.comment()
                self.assertEqual(markers.parse(body)["job"], self.job)
                self.assertEqual(markers.parse(body)["outcome"], "needs_input")


class NoticeTest(PublishTestCase):
    def bot_comment(self, comment_id: int, body: str, *, author: tuple[str, int] = (BOT.login, BOT.user_id)) -> Comment:
        return Comment(comment_id, author[0], author[1], "2026-11-27T09:00:00Z", body)

    def test_post_notice_posts_the_fixed_text(self):
        self.publisher.post_notice(ISSUE, "needs-app")
        self.assertEqual(self.github.calls, [("POST", self.comments, {"body": compose.notice("needs-app")})])

    def test_post_notice_does_not_repeat_the_last_marker(self):
        issue = dataclasses.replace(ISSUE, comments=(self.bot_comment(5, compose.notice("needs-app")),))
        self.publisher.post_notice(issue, "needs-app")
        self.assertEqual(self.github.calls, [])

    def test_post_notice_posts_when_the_last_marker_is_something_else(self):
        run = markers.encode({"kind": "run", "job": self.job, "stage": "fix_issue", "outcome": "needs_input"})
        cases = {
            "a run after the notice": (self.bot_comment(5, compose.notice("needs-app")), self.bot_comment(6, run)),
            "another notice": (self.bot_comment(5, compose.notice("untrusted-author")),),
            "the notice from another account": (self.bot_comment(5, compose.notice("needs-app"), author=("x", 9)),),
        }
        for name, comments in cases.items():
            with self.subTest(name):
                self.github.calls.clear()
                self.publisher.post_notice(dataclasses.replace(ISSUE, comments=comments), "needs-app")
                self.assertEqual(self.github.calls, [("POST", self.comments, {"body": compose.notice("needs-app")})])

    def test_post_notice_refuses_an_unknown_notice(self):
        with self.assertRaises(ValueError):
            self.publisher.post_notice(ISSUE, "anything")
        self.assertEqual(self.github.calls, [])


class SetStatusTest(PublishTestCase):
    def test_set_status_removes_then_adds_and_tolerates_a_missing_label(self):
        self.github.missing.add(f"{self.labels}/status%3Aqueued")
        self.publisher.set_status(12, "status:needs-human", ["status:building", "status:queued"])
        self.assertEqual(self.github.calls, [
            ("DELETE", f"{self.labels}/status%3Abuilding", None),
            ("POST", self.labels, {"labels": ["status:needs-human"]}),
        ])

    def test_set_status_lets_any_other_error_through(self):
        self.github.fail.add(f"{self.labels}/status%3Abuilding")
        with self.assertRaises(GitHubError):
            self.publisher.set_status(12, "status:needs-human", ["status:building"])
        self.assertEqual(self.github.calls, [])

    def test_set_status_without_a_label_to_add_only_removes(self):
        self.publisher.set_status(12, None, ["status:queued"])
        self.assertEqual(self.github.calls, [("DELETE", f"{self.labels}/status%3Aqueued", None)])


if __name__ == "__main__":
    unittest.main()

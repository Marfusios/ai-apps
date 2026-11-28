"""Tests for publishing a finished run: a real spool, real git repositories and an in-memory GitHub."""

import dataclasses
import itertools
import json
import os
import re
import tempfile
import unittest
from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from factory import bundle_check, compose, gitops, jobs, markers
from factory import config as factory_config
from factory.github_api import GitHubError, GraphQLRefused
from factory.gitops import GitError, PushRefused
from factory.publish import MAX_REPLIES, MAX_SETTLED_BYTES, Publisher
from factory.result import MAX_RESULT_BYTES
from factory.snapshot import Bot, Comment, Issue, PullRequest
from factory.spool import Spool, SpoolError, new_job_id
from factory.tests.fakes import FIRST_NUMBER, FakeGitHub
from factory.tests.gitrepo import Repo

CONFIG = factory_config.load()
BOT = Bot("factory-test[bot]", 4242)
BRANCH = "factory/fix-12"
NOW = datetime(2026, 11, 27, 10, 15, 0, tzinfo=timezone.utc)
CLOSING_TIME = NOW + timedelta(minutes=3)  # what the publisher's own clock says when it closes a job
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
PULL = 7  # the number of the pull request a fix or revise run works on
OPEN_PULLS = {"head": "owner:factory/fix-12", "base": "main", "state": "open", "per_page": "10"}
ALL_COMMENTS = {"per_page": "100"}
MEGABYTE = bundle_check.MEGABYTE
SETTLED_LIMIT = 10_000_000


def key(path: str, params: dict) -> tuple:
    return (path, tuple(sorted(params.items())))


def pull_json(number: int, *, ref: str = BRANCH, author: tuple[str, int] = (BOT.login, BOT.user_id),
              url: str | None = None) -> dict:
    """An open pull request as GitHub lists it."""
    return {"number": number, "state": "open", "head": {"ref": ref}, "base": {"ref": "main"},
            "user": {"login": author[0], "id": author[1]},
            "html_url": url or f"https://github.com/owner/name/pull/{number}"}


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


REPLY_PATH = re.compile(r"/repos/owner/name/pulls/([0-9]+)/comments/[0-9]+/replies")


class ReviewingGitHub(FakeGitHub):
    """A FakeGitHub that also lists the replies it was sent as review comments, and refuses a write with a status.

    `refuse` maps `(method, path)` to the status that write answers with, and `refused` records each such attempt.
    """

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self.refuse: dict[tuple[str, str], int] = {}
        self.refused: list[tuple[str, str]] = []
        self.sequence: list[tuple[str, str]] = []  # every write and every GraphQL call, in order

    def _check(self, method: str, path: str) -> None:
        if (method, path) in self.refuse:
            self.refused.append((method, path))
            raise GitHubError(self.refuse[(method, path)], f"{method} {path} failed")
        super()._check(method, path)

    def graphql(self, query: str, variables: Mapping[str, object]) -> dict:
        answer = super().graphql(query, variables)
        self.sequence.append(("GRAPHQL", str(variables["id"])))
        return answer

    def _write(self, method: str, path: str, body: Mapping) -> object:
        answer = super()._write(method, path, body)
        self.sequence.append((method, path))
        found = REPLY_PATH.fullmatch(path)
        if method == "POST" and found:
            self._create(f"{self.repo}/pulls/{found[1]}/comments", {
                "id": next(self._numbers), "user": dict(self.user), "created_at": "2026-01-01T00:00:00Z",
                "body": body.get("body")})
        return answer


class PublishTestCase(unittest.TestCase):
    stage = "fix_issue"  # the stage of the job `new_job` submits
    request_extra: dict = {}  # more of the request: its round and pull request
    github_class = FakeGitHub

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
        self.mirror = self.upstream.bare_clone(self.tmp / "mirror.git")
        self.remote = self.upstream.bare_clone(self.tmp / "remote.git")
        self.workrepo = self.tmp / "work.git"
        gitops.ensure_workrepo(self.workrepo, self.mirror)
        self.spool = Spool(self.tmp / "spool")
        self.spool.prepare("dispatcher")
        self.github = self.github_class(user={"login": BOT.login, "id": BOT.user_id})
        self.pulls = f"{self.github.repo}/pulls"
        self.comments = f"{self.github.repo}/issues/12/comments"
        self.pull_comments = f"{self.github.repo}/issues/{PULL}/comments"  # a pull request's own conversation
        self.review_comments = f"{self.github.repo}/pulls/{PULL}/comments"  # the comments on its code
        self.labels = f"{self.github.repo}/issues/12/labels"
        self.branch_ref = f"{self.github.repo}/git/ref/heads/{BRANCH}"
        self.github.answers[key(self.pulls, OPEN_PULLS)] = []
        self.github.answers[key(self.comments, ALL_COMMENTS)] = []
        self.github.answers[key(self.pull_comments, ALL_COMMENTS)] = []
        self.github.answers[key(self.review_comments, ALL_COMMENTS)] = []
        self.pull_path = f"{self.github.repo}/pulls/{PULL}"
        self.github.answers[key(self.pull_path, {})] = {"number": PULL, "user": {"login": BOT.login, "id": BOT.user_id}}
        self.github.missing.add(self.branch_ref)  # the work branch is not on GitHub yet
        self.scratch = self.tmp / "scratch"
        self.publisher = Publisher(
            spool=self.spool, github=self.github, config=config, bot=BOT, workrepo=self.workrepo,
            scratch=self.scratch, push_url=str(self.remote), token=lambda: TOKEN, clock=lambda: CLOSING_TIME,
        )
        self.job = self.new_job()

    def new_job(self) -> str:
        job = new_job_id(self.stage, 12, NOW)
        request = jobs.request_file(job_id=job, stage=self.stage, app="demo", branch=BRANCH, base_sha=self.base,
                                    repository="owner/name", config=CONFIG, bot=BOT, **self.request_extra)
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

    def quarantined(self) -> str | None:
        return gitops.resolve(self.workrepo, f"refs/quarantine/{self.job}")

    def run_file(self, name: str) -> Path:
        """A file the runner wrote, for a test that plays a runner changing it afterwards."""
        return self.spool.root / "runs" / self.job / name

    def settled(self) -> dict | None:
        return self.spool.read_job_json(self.job, "settled.json", SETTLED_LIMIT)

    def rewrite_request(self, **changes: object) -> None:
        request = self.spool.request(self.job)
        self.spool.job_file(self.job, "request.json").write_text(json.dumps({**request, **changes}))

    def branch_on_github(self, sha: str) -> None:
        """GitHub's answer for the work branch: it exists and names this commit."""
        self.github.missing.discard(self.branch_ref)
        self.github.answers[key(self.branch_ref, {})] = {"ref": f"refs/heads/{BRANCH}", "object": {
            "type": "commit", "sha": sha}}

    def someone_pushes(self) -> str:
        """A person's commit on the work branch of the remote, which the run's commits do not descend from."""
        self.upstream.switch("someone", self.base)
        theirs = self.upstream.commit({"apps/demo/a.txt": "theirs\n"})
        self.upstream.git("push", "-q", str(self.remote), f"{theirs}:refs/heads/{BRANCH}")
        return theirs

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
        self.assertTrue(created["body"].startswith("Closes #12\n"))  # compose puts the one acting reference first
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
        self.assertIsNone(self.quarantined())
        self.assertNothingPrivateWritten()

    def test_an_open_pull_request_is_updated_and_not_opened_again(self):
        self.github.answers[key(self.pulls, OPEN_PULLS)] = [pull_json(7, url="https://example.test/pull/7")]
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.assertEqual(self.publish(), "done")
        self.assertEqual(self.writes("POST", self.pulls), [])
        [patched] = self.writes("PATCH", f"{self.pulls}/7")
        self.assertEqual(patched["title"], compose.pull_request_title("Fix the greeting"))
        self.assertTrue(patched["body"].startswith("Closes #12\n"))
        self.assertEqual(self.github.posted(f"{self.github.repo}/issues/7/labels"), {"labels": ["stage:fix"]})
        # GitHub's link has an unexpected shape, so the comment links the pull request it builds itself.
        self.assertIn("Pull request: https://github.com/owner/name/pull/7", self.comment())

    def test_publishing_twice_after_each_possible_interruption_leaves_one_of_everything(self):
        writes = (("POST", "pulls"), ("POST", f"issues/{FIRST_NUMBER}/labels"), ("POST", "issues/12/comments"),
                  ("POST", "issues/12/labels"))
        for method, path in writes:
            with self.subTest(failing=f"{method} {path}"):
                self.build()
                self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
                self.github.fail_once.add((method, f"{self.github.repo}/{path}"))  # the write fails, not the lookup
                with self.assertRaises(GitHubError):
                    self.publish()
                self.assertEqual(self.spool.state(self.job), "finished")
                self.assertEqual(self.quarantined(), self.work_head)  # kept for the repeat's push
                self.assertEqual(self.publish(), "done")
                self.assertEqual(self.remote_branch(), self.work_head)
                self.assertEqual(len(self.writes("POST", self.pulls)), 1)
                self.assertEqual(len(self.writes("POST", self.comments)), 1)
                self.assertEqual(self.spool.state(self.job), "closed")
                self.assertIsNone(self.quarantined())

    def test_a_failure_on_the_status_label_leaves_the_job_open_and_the_repeat_adds_nothing_twice(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.github.fail_once.add(("POST", self.labels))
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

    def test_the_close_is_stamped_with_the_time_it_happens_not_the_time_of_the_poll(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.assertEqual(self.publish(), "done")
        self.assertEqual(self.spool.read_job_json(self.job, "closed.json")["closed_at"], stamp(CLOSING_TIME))


class SettledOnceTest(PublishTestCase):
    def test_the_outcome_is_stored_before_the_first_write(self):
        self.finish(result=done_result(follow_ups=[{"title": "Tidy", "reason": "Later."}]),
                    bundle=self.bundle_of(GOOD_CHANGE))
        unreachable = dataclasses.replace(self.publisher, push_url=str(self.tmp / "no-such-remote.git"))
        with self.assertRaises(GitError):
            unreachable.publish(self.job, ISSUE, NOW)
        settled = self.settled()
        self.assertEqual((settled["outcome"], settled["reason"], settled["head_sha"], settled["commits"]),
                         ("done", None, self.work_head, 1))
        self.assertEqual((settled["summary"], settled["follow_ups"], settled["pull_request"]),
                         ("The greeting now says hello.", [{"title": "Tidy", "reason": "Later."}],
                          {"title": "Fix the greeting", "body": "Spell hello right."}))
        self.assertEqual(self.github.calls, [])

    def test_a_repeat_keeps_the_settled_outcome_when_the_runner_rewrites_its_files(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.github.fail_once.add(("POST", self.comments))
        with self.assertRaises(GitHubError):
            self.publish()
        self.assertEqual(len(self.writes("POST", self.pulls)), 1)
        self.run_file("result.json").write_text(json.dumps(failed_result()), encoding="utf-8")
        self.run_file("commits.bundle").write_bytes(b"something else")
        with mock.patch.object(self.spool, "read_run_file", wraps=self.spool.read_run_file) as read, \
                mock.patch.object(self.spool, "run_record", wraps=self.spool.run_record) as record:
            self.assertEqual(self.publish(), "done")
        read.assert_not_called()
        record.assert_not_called()
        body = self.comment()
        self.assertEqual(markers.parse(body)["outcome"], "done")
        self.assertIn("The greeting now says hello.", body)
        self.assertEqual(len(self.writes("POST", self.pulls)), 1)
        self.assertEqual(self.spool.state(self.job), "closed")

    def test_a_repeat_whose_checked_commits_are_gone_is_an_internal_error_and_reads_no_bundle(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.github.fail_once.add(("POST", self.pulls))
        with self.assertRaises(GitHubError):
            self.publish()
        rebuilt = self.tmp / "rebuilt.git"  # the work repository was made again, without the run's commits
        gitops.ensure_workrepo(rebuilt, self.mirror)
        with mock.patch.object(self.spool, "read_run_file", wraps=self.spool.read_run_file) as read:
            self.assertEqual(dataclasses.replace(self.publisher, workrepo=rebuilt).publish(self.job, ISSUE, NOW),
                             "crashed")
        read.assert_not_called()
        self.assertEqual(self.writes("POST", self.pulls), [])
        body = self.comment()
        self.assertIn(compose.REASON_WORDS["internal"], body)
        self.assertNotIn("The greeting now says hello.", body)
        self.assertEqual((self.settled()["outcome"], self.settled()["reason"]), ("crashed", "internal"))
        self.assertNeedsAPerson()

    def test_a_repeat_finds_the_checked_commits_without_their_quarantine_ref(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.github.fail_once.add(("POST", self.pulls))
        with self.assertRaises(GitHubError):
            self.publish()
        gitops.run_git(self.workrepo, "update-ref", "-d", f"refs/quarantine/{self.job}")
        self.assertEqual(self.publish(), "done")
        self.assertEqual(self.remote_branch(), self.work_head)
        self.assertEqual(len(self.writes("POST", self.pulls)), 1)

    def test_a_close_that_fails_after_a_complete_publication_is_repeated_without_undoing_it(self):
        for outcome, result in {"done": done_result(), "needs_input": needs_input_result()}.items():
            with self.subTest(outcome):
                self.build()
                self.finish(result=result, bundle=self.bundle_of(GOOD_CHANGE))
                full_disk = SpoolError("closed.json cannot be written: No space left on device")
                with mock.patch.object(self.spool, "close", side_effect=full_disk), self.assertRaises(SpoolError):
                    self.publish()
                self.assertEqual(self.spool.state(self.job), "finished")
                self.assertEqual(self.quarantined(), self.work_head)  # the job is closed before the clean-up
                first = list(self.github.calls)
                self.assertEqual(self.publish(), outcome)
                repeat = self.github.calls[len(first):]
                self.assertEqual(len(self.writes("POST", self.comments)), 1)
                self.assertEqual(len(self.writes("POST", self.pulls)), 1 if outcome == "done" else 0)
                self.assertEqual([call for call in repeat if call[1].startswith(self.labels)],
                                 [call for call in first if call[1].startswith(self.labels)])
                closed = json.loads(self.spool.job_file(self.job, "closed.json").read_text())
                self.assertEqual(closed["reason"], outcome)
                self.assertIsNone(self.quarantined())

    def test_an_unusable_stored_outcome_is_an_internal_error_without_reading_the_run_again(self):
        damages = {
            "an empty file": lambda record: b"",
            "a JSON list": lambda record: b"[]",
            "a list field holding null": lambda record: json.dumps({**record, "problems": None}).encode("utf-8"),
            "an unknown field": lambda record: json.dumps({**record, "extra": 1}).encode("utf-8"),
            "a head that is not a commit name": lambda record: json.dumps({**record, "head_sha": "--all"}).encode(),
            "a model compose refuses": lambda record: json.dumps({**record, "model": "Some Model!"}).encode(),
        }
        for name, damage in damages.items():
            with self.subTest(name):
                self.build()
                self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
                unreachable = dataclasses.replace(self.publisher, push_url=str(self.tmp / "no-such-remote.git"))
                with self.assertRaises(GitError):
                    unreachable.publish(self.job, ISSUE, NOW)
                self.spool.job_file(self.job, "settled.json").write_bytes(damage(self.settled()))
                with mock.patch.object(self.spool, "read_run_file", wraps=self.spool.read_run_file) as read, \
                        mock.patch.object(self.spool, "run_record", wraps=self.spool.run_record) as record:
                    self.assertEqual(self.publish(), "crashed")
                read.assert_not_called()
                record.assert_not_called()
                self.assertIsNone(self.remote_branch())
                self.assertIn(compose.REASON_WORDS["internal"], self.comment())
                self.assertEqual((self.settled()["outcome"], self.settled()["reason"]), ("crashed", "internal"))
                self.assertNeedsAPerson()

    def test_a_result_at_every_text_limit_is_stored_within_the_bound(self):
        wide = "é"  # two bytes in the result, six once JSON escapes it
        result = needs_input_result(
            summary=wide * 4_000, questions=[wide * 2_000] * 20,
            follow_ups=[{"title": wide * 120, "reason": wide * 1_000}] * 10,
            pull_request={"title": wide * 120, "body": wide * 20_000},
        )
        raw = json.dumps(result, ensure_ascii=False).encode("utf-8")
        self.assertLessEqual(len(raw), MAX_RESULT_BYTES)
        self.finish(result=raw)
        self.assertEqual(self.publish(), "needs_input")
        stored = self.spool.job_file(self.job, "settled.json").stat().st_size
        self.assertGreater(stored, 2 * len(raw))
        self.assertLessEqual(stored, MAX_SETTLED_BYTES)
        self.assertEqual(self.spool.read_job_json(self.job, "settled.json", MAX_SETTLED_BYTES)["summary"], wide * 4_000)

    def test_text_that_compose_refuses_is_an_internal_error_before_anything_is_written(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        with mock.patch.object(compose, "pull_request_body", side_effect=ValueError("refused")):
            self.assertEqual(self.publish(), "crashed")
        self.assertIsNone(self.remote_branch())
        self.assertEqual([call for call in self.github.calls if call[1].startswith(self.pulls)], [])
        self.assertIn(compose.REASON_WORDS["internal"], self.comment())
        self.assertEqual((self.settled()["outcome"], self.settled()["head_sha"]), ("crashed", None))
        self.assertNeedsAPerson()

    def test_an_internal_error_names_no_model_so_a_model_compose_refuses_cannot_fail_it_again(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        with mock.patch.object(compose, "MODEL", re.compile("")):  # compose now refuses every model but none
            self.assertEqual(self.publish(), "crashed")
        self.assertIsNone(self.remote_branch())
        self.assertIn("model `unknown`", self.comment())
        self.assertEqual((self.settled()["outcome"], self.settled()["model"]), ("crashed", ""))
        self.assertNeedsAPerson()

    def test_a_request_for_another_job_or_another_branch_stops_before_anything_is_written(self):
        cases = {"another job": ({"job_id": new_job_id("fix_issue", 12, NOW)}, "another job"),
                 "another branch": ({"branch": "factory/fix-13"}, "issue #12")}
        for name, (change, named) in cases.items():
            with self.subTest(name):
                self.build()
                self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
                self.rewrite_request(**change)
                with self.assertRaises(SpoolError) as raised:
                    self.publish()
                self.assertIn(named, str(raised.exception))
                self.assertEqual(self.github.calls, [])
                self.assertIsNone(self.remote_branch())
                self.assertIsNone(gitops.resolve(self.remote, "refs/heads/factory/fix-13"))
                self.assertIsNone(self.settled())
                self.assertEqual(self.spool.state(self.job), "finished")

    def test_a_repeat_called_for_another_issue_stops_and_keeps_the_stored_outcome(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.github.fail_once.add(("POST", self.comments))
        with self.assertRaises(GitHubError):
            self.publish()
        stored, written = self.settled(), list(self.github.calls)
        with self.assertRaises(SpoolError) as raised:
            self.publish(issue=dataclasses.replace(ISSUE, number=13))
        self.assertIn("issue #13", str(raised.exception))
        self.assertEqual(self.github.calls, written)
        self.assertIsNone(gitops.resolve(self.remote, "refs/heads/factory/fix-13"))
        self.assertEqual(self.settled(), stored)
        self.assertEqual(self.spool.state(self.job), "finished")


class PullRequestLookupTest(PublishTestCase):
    def setUp(self):
        super().setUp()
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))

    def listing(self, answer: object) -> None:
        self.github.answers[key(self.pulls, OPEN_PULLS)] = answer

    def test_a_listing_that_is_not_a_list_stops_before_a_pull_request_is_opened(self):
        self.listing({"message": "not a list"})
        with self.assertRaises(GitHubError):
            self.publish()
        self.assertEqual(self.writes("POST", self.pulls), [])
        self.assertEqual(self.writes("POST", self.comments), [])
        self.assertEqual(self.spool.state(self.job), "finished")

    def test_entries_without_a_number_or_for_another_branch_are_not_the_runs_pull_request(self):
        without_head = pull_json(9)
        del without_head["head"]
        self.listing(["x", None, {**pull_json(7), "number": "7"}, {**pull_json(6), "number": True},
                      pull_json(8, ref="factory/fix-13"), without_head])
        self.assertEqual(self.publish(), "done")
        self.assertEqual(len(self.writes("POST", self.pulls)), 1)
        self.assertEqual([call for call in self.github.calls if call[0] == "PATCH"], [])
        self.assertIn(f"Pull request: https://github.com/owner/name/pull/{FIRST_NUMBER}", self.comment())

    def test_a_pull_request_another_account_opened_for_the_branch_is_linked_but_not_changed(self):
        self.listing([pull_json(7, author=("someone", 99))])
        self.assertEqual(self.publish(), "done")
        self.assertEqual(self.writes("POST", self.pulls), [])
        self.assertEqual([call for call in self.github.calls if call[0] == "PATCH"], [])
        self.assertEqual(self.writes("POST", f"{self.github.repo}/issues/7/labels"), [])
        self.assertIn("Pull request: https://github.com/owner/name/pull/7", self.comment())

    def test_the_bots_own_pull_request_comes_before_another_accounts(self):
        self.listing([pull_json(9, author=("someone", 99)), pull_json(8), pull_json(10, author=(BOT.login, 77))])
        self.assertEqual(self.publish(), "done")
        self.assertEqual([call[1] for call in self.github.calls if call[0] == "PATCH"], [f"{self.pulls}/8"])
        self.assertEqual(self.github.posted(f"{self.github.repo}/issues/8/labels"), {"labels": ["stage:fix"]})
        self.assertIn("Pull request: https://github.com/owner/name/pull/8", self.comment())

    def test_an_answer_without_a_number_to_opening_the_pull_request_leaves_the_job_unclosed(self):
        self.github.responses[("POST", self.pulls)] = {"html_url": "https://github.com/owner/name/pull/5"}
        with self.assertRaises(GitHubError):
            self.publish()
        self.assertEqual(self.writes("POST", self.comments), [])
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
            "a bundle over the limit": (limits(max_bundle_megabytes=1), None, bundle_check.missing_or_too_large(1)),
        }
        for name, (config, change, problem) in cases.items():
            with self.subTest(name):
                self.build(config)
                bundle = self.bundle_of(change) if change else self.tmp / "big.bundle"
                if change is None:
                    bundle.write_bytes(b"x" * (MEGABYTE + 1))
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

    def test_a_finding_in_any_text_that_is_posted_blocks_publication(self):
        cases = {
            "a follow-up": (done_result(follow_ups=[
                {"title": "Move the host", "reason": f"It is at {PRIVATE_ADDRESS}."}]), "private network address"),
            "a summary with a key split by a control character": (
                done_result(summary=f"Tested with {KEY[:12]}\x1c{KEY[12:]} today."), "possible provider key"),
            "the reason a failed run gives": (failed_result(failure_reason=f"The key {KEY} was refused."),
                                              "possible provider key"),
            "a question": (needs_input_result(questions=[f"Is {PERSONAL_PATH} right?"]), "personal filesystem path"),
            "the pull request's title": (done_result(pull_request={"title": f"Use {KEY}", "body": "b"}),
                                         "possible provider key"),
            "the pull request's body": (done_result(pull_request={"title": "t", "body": f"At {PRIVATE_ADDRESS}"}),
                                        "private network address"),
        }
        for name, (result, label) in cases.items():
            with self.subTest(name):
                self.build()
                self.finish(result=result, bundle=self.bundle_of(GOOD_CHANGE))
                self.assertEqual(self.publish(), "rejected")
                self.assertIsNone(self.remote_branch())
                body = self.comment()
                self.assertIn(f"- the result's text contains {label}", body)
                self.assertNotIn(result["summary"][:11], body)
                self.assertNotIn(KEY[:12], body)
                self.assertNeedsAPerson()

    def test_the_verification_is_never_posted_so_a_host_path_in_it_does_not_block(self):
        verification = [{"command": f"cat {PERSONAL_PATH}/x", "exit_code": 0, "summary": f"at {PRIVATE_ADDRESS}"}]
        self.finish(result=done_result(verification=verification), bundle=self.bundle_of(GOOD_CHANGE))
        self.assertEqual(self.publish(), "done")
        self.assertEqual(self.remote_branch(), self.work_head)
        self.assertNotIn(PERSONAL_PATH, json.dumps([written for _, _, written in self.github.calls]))

    def test_an_oversized_bundle_is_rejected_without_being_copied_whole(self):
        self.build(limits(max_bundle_megabytes=1))
        oversized = self.tmp / "big.bundle"
        oversized.write_bytes(b"x" * (MEGABYTE + 1))
        self.finish(result=done_result(), bundle=oversized)
        with mock.patch.object(self.spool, "read_run_file", wraps=self.spool.read_run_file) as read:
            self.assertEqual(self.publish(), "rejected")
        read.assert_any_call(self.job, "commits.bundle", MEGABYTE)
        self.assertFalse(self.scratch.exists())
        self.assertIn(f"- {bundle_check.missing_or_too_large(1)}", self.comment())
        self.assertNeedsAPerson()


REFUSED_PUSH = "GitHub refused the push of the checked commits"
BRANCH_MOVED = "the work branch changed on GitHub while the run was going"


class WorkBranchOnGitHubTest(PublishTestCase):
    def assertRejectedFor(self, problem: str) -> None:
        body = self.comment()
        self.assertEqual(markers.parse(body)["outcome"], "rejected")
        self.assertIn(f"- {problem}", body)
        self.assertEqual(self.writes("POST", self.pulls), [])
        settled = self.settled()
        self.assertEqual((settled["outcome"], settled["head_sha"], settled["commits"], settled["problems"]),
                         ("rejected", None, 0, [problem]))
        self.assertNeedsAPerson()

    def test_a_push_github_refuses_is_rejected_with_a_comment_instead_of_being_retried(self):
        for outcome, result in {"done": done_result(), "needs_input": needs_input_result()}.items():
            with self.subTest(outcome):
                self.build()
                self.finish(result=result, bundle=self.bundle_of(GOOD_CHANGE))
                theirs = self.someone_pushes()  # GitHub's listing lags: it does not show the branch yet
                self.assertEqual(self.publish(), "rejected")
                self.assertEqual(self.remote_branch(), theirs)
                self.assertRejectedFor(REFUSED_PUSH)

    def test_a_refusal_the_push_reports_is_rejected_without_a_head(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        with mock.patch("factory.gitops.push", side_effect=PushRefused("push", 1)):
            self.assertEqual(self.publish(), "rejected")
        self.assertRejectedFor(REFUSED_PUSH)

    def test_a_repeat_after_a_refused_push_pushes_nothing_and_posts_once(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.someone_pushes()
        self.github.fail_once.add(("POST", self.comments))
        with self.assertRaises(GitHubError):
            self.publish()
        with mock.patch("factory.gitops.push") as push:
            self.assertEqual(self.publish(), "rejected")
        push.assert_not_called()
        self.assertRejectedFor(REFUSED_PUSH)

    def test_a_push_that_fails_for_another_reason_is_left_for_the_next_attempt(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        for status in (1, 128, None):  # 1 too: git exits 1 when an upload fails in transit, which is no refusal
            with self.subTest(status=status), \
                    mock.patch("factory.gitops.push", side_effect=GitError("push", status if status else "timeout")):
                with self.assertRaises(GitError):
                    self.publish()
                self.assertEqual(self.github.calls, [])
                self.assertEqual(self.settled()["outcome"], "done")
                self.assertEqual(self.spool.state(self.job), "finished")

    def test_a_work_branch_someone_moved_on_github_is_rejected_before_the_push(self):
        for outcome, result in {"done": done_result(), "needs_input": needs_input_result()}.items():
            with self.subTest(outcome):
                self.build()
                self.finish(result=result, bundle=self.bundle_of(GOOD_CHANGE))
                self.branch_on_github("c" * 40)
                with mock.patch("factory.gitops.push") as push:
                    self.assertEqual(self.publish(), "rejected")
                push.assert_not_called()
                self.assertRejectedFor(BRANCH_MOVED)

    def test_a_work_branch_at_the_base_or_at_the_checked_head_is_pushed(self):
        for name in ("the base", "the checked head, after an earlier push"):
            with self.subTest(name):
                self.build()
                self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
                self.branch_on_github(self.base if name == "the base" else self.work_head)
                self.assertEqual(self.publish(), "done")
                self.assertEqual(self.remote_branch(), self.work_head)
                self.assertEqual(len(self.writes("POST", self.pulls)), 1)

    def test_an_answer_for_the_branch_that_is_not_a_commit_stops_before_anything_is_written(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        for answer in ([], {"object": None}, {"object": {"sha": "--all"}}, None):
            with self.subTest(answer=answer):
                self.github.missing.discard(self.branch_ref)
                self.github.answers[key(self.branch_ref, {})] = answer
                with self.assertRaises(GitHubError):
                    self.publish()
                self.assertEqual(self.github.calls, [])
                self.assertIsNone(self.remote_branch())
                self.assertEqual(self.spool.state(self.job), "finished")

    def test_a_run_without_commits_does_not_look_at_the_branch(self):
        self.github.missing.discard(self.branch_ref)
        self.github.fail.add(self.branch_ref)
        self.finish(result=needs_input_result())
        self.assertEqual(self.publish(), "needs_input")


class GiveUpTest(PublishTestCase):
    def give_up(self) -> str:
        with mock.patch.object(self.spool, "read_run_file", wraps=self.spool.read_run_file) as read, \
                mock.patch.object(self.spool, "run_record", wraps=self.spool.run_record) as record:
            outcome = self.publisher.give_up(self.job, ISSUE, NOW)
        read.assert_not_called()
        record.assert_not_called()
        return outcome

    def assertInternalError(self) -> None:
        body = self.comment()
        self.assertEqual(markers.parse(body)["outcome"], "crashed")
        self.assertIn(compose.REASON_WORDS["internal"], body)
        self.assertNotIn("The greeting now says hello.", body)
        self.assertEqual((self.settled()["outcome"], self.settled()["reason"]), ("crashed", "internal"))
        self.assertEqual(self.spool.read_job_json(self.job, "closed.json"),
                         {"reason": "crashed", "closed_at": stamp(CLOSING_TIME)})
        self.assertNeedsAPerson()

    def test_giving_up_shows_an_internal_error_over_the_stored_outcome_and_pushes_nothing(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        unreachable = dataclasses.replace(self.publisher, push_url=str(self.tmp / "no-such-remote.git"))
        with self.assertRaises(GitError):
            unreachable.publish(self.job, ISSUE, NOW)
        self.assertEqual(self.settled()["outcome"], "done")
        self.assertEqual(self.give_up(), "crashed")
        self.assertIsNone(self.remote_branch())
        self.assertEqual(self.writes("POST", self.pulls), [])
        self.assertIn("· 12 min ·", self.comment())  # the stored duration is kept
        self.assertInternalError()

    def test_giving_up_before_anything_was_stored_still_reads_nothing_of_the_run(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.assertIsNone(self.settled())
        self.assertEqual(self.give_up(), "crashed")
        self.assertIn("model `unknown`", self.comment())
        self.assertInternalError()

    def test_giving_up_again_after_an_interruption_posts_one_comment(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.github.fail_once.add(("POST", self.labels))
        with self.assertRaises(GitHubError):
            self.publisher.give_up(self.job, ISSUE, NOW)
        self.assertEqual(self.spool.state(self.job), "finished")
        self.assertEqual(self.give_up(), "crashed")
        self.assertInternalError()

    def test_giving_up_refuses_a_request_that_belongs_to_another_issue(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        with self.assertRaises(SpoolError):
            self.publisher.give_up(self.job, dataclasses.replace(ISSUE, number=13), NOW)
        self.assertEqual(self.github.calls, [])
        self.assertIsNone(self.settled())


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
            "a reset more than six hours ahead": (NOW + timedelta(hours=6, seconds=1), fallback),
            "a reset eight days ahead": (NOW + timedelta(days=8), fallback),
            "a reset at the end of the range": (datetime(2100, 1, 1, tzinfo=timezone.utc), fallback),
            "a reset six hours ahead": (NOW + timedelta(hours=6), stamp(NOW + timedelta(hours=6))),
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
    NOTICE = compose.notice("needs-app")
    POSTED = ("POST", "/repos/owner/name/issues/12/comments", {"body": compose.notice("needs-app")})

    def listed(self, *comments: tuple[int, str, int, str]) -> None:
        """GitHub's fresh listing of the issue's comments, each as (id, login, user id, body)."""
        self.github.answers[key(self.comments, ALL_COMMENTS)] = [comment_json(*comment) for comment in comments]

    def bot(self, comment_id: int, body: str) -> tuple[int, str, int, str]:
        return (comment_id, BOT.login, BOT.user_id, body)

    def test_post_notice_posts_the_fixed_text(self):
        self.publisher.post_notice(ISSUE, "needs-app")
        self.assertEqual(self.github.calls, [self.POSTED])

    def test_post_notice_does_not_repeat_the_notice_github_lists_last_although_the_poll_missed_it(self):
        self.listed(self.bot(5, self.NOTICE), (6, "stranger", 9, "app: whatever"), self.bot(7, "plain text"))
        self.assertEqual(ISSUE.comments, ())
        self.publisher.post_notice(ISSUE, "needs-app")
        self.assertEqual(self.github.calls, [])

    def test_post_notice_answers_a_trusted_comment_after_the_same_notice(self):
        self.listed(self.bot(5, self.NOTICE), (6, "Marfusios", 1, "app: still-wrong"))
        self.publisher.post_notice(ISSUE, "needs-app")
        self.assertEqual(self.github.calls, [self.POSTED])

    def test_post_notice_reads_the_fresh_listing_and_not_the_poll(self):
        issue = dataclasses.replace(ISSUE, comments=(Comment(5, BOT.login, BOT.user_id, "2026-11-27T09:00:00Z",
                                                             self.NOTICE),))
        self.publisher.post_notice(issue, "needs-app")
        self.assertEqual(self.github.calls, [self.POSTED])

    def test_post_notice_posts_when_the_last_marker_is_something_else(self):
        run = markers.encode({"kind": "run", "job": self.job, "stage": "fix_issue", "outcome": "needs_input"})
        cases = {
            "a run after the notice": (self.bot(5, self.NOTICE), self.bot(6, run)),
            "another notice": (self.bot(5, compose.notice("untrusted-author")),),
            "the notice from another account": ((5, "x", 9, self.NOTICE),),
        }
        for name, comments in cases.items():
            with self.subTest(name):
                self.build()  # a fresh GitHub: the fake lists the notices it was given
                self.listed(*comments)
                self.publisher.post_notice(ISSUE, "needs-app")
                self.assertEqual(self.github.calls, [self.POSTED])

    def with_pull(self, open_: bool = True) -> Issue:
        return dataclasses.replace(ISSUE, pull_request=PullRequest(PULL, open_, False, "https://example.test/pull/7"))

    def listed_pull(self, *comments: tuple[int, str, int, str]) -> None:
        """GitHub's fresh listing of the pull request's comments, each as (id, login, user id, body)."""
        self.github.answers[key(self.pull_comments, ALL_COMMENTS)] = [comment_json(*comment) for comment in comments]

    def exhausted_posted(self, number: int = PULL) -> tuple:
        body = {"body": compose.notice("fix-rounds-exhausted")}
        return ("POST", f"/repos/owner/name/issues/{number}/comments", body)

    def test_a_second_exhausted_notice_is_posted_once_on_the_pull_request(self):
        exhausted = compose.notice("fix-rounds-exhausted")
        self.listed(self.bot(5, exhausted))
        self.listed_pull((6, "Marfusios", 1, "/factory retry"))
        self.publisher.post_notice(self.with_pull(), "fix-rounds-exhausted")
        self.assertEqual(self.github.calls, [self.exhausted_posted()])
        self.github.calls.clear()
        self.publisher.post_notice(self.with_pull(), "fix-rounds-exhausted")  # the next poll sees it last
        self.assertEqual(self.github.calls, [])

    def test_the_exhausted_notice_already_last_in_the_merged_stream_is_not_posted_again(self):
        exhausted = compose.notice("fix-rounds-exhausted")
        self.listed(self.bot(5, exhausted))
        self.listed_pull((4, "stranger", 9, "hello"))
        self.publisher.post_notice(self.with_pull(), "fix-rounds-exhausted")
        self.assertEqual(self.github.calls, [])

    def test_a_trusted_comment_after_the_notice_on_either_side_lets_it_be_posted_again(self):
        exhausted = compose.notice("fix-rounds-exhausted")
        trusted = (9, "Marfusios", 1, "please look")
        cases = {
            "on the issue": ((self.bot(5, exhausted), trusted), ()),
            "on the pull request": ((self.bot(5, exhausted),), (trusted,)),
        }
        for name, (on_issue, on_pull) in cases.items():
            with self.subTest(name):
                self.build()
                self.listed(*on_issue)
                self.listed_pull(*on_pull)
                self.publisher.post_notice(self.with_pull(), "fix-rounds-exhausted")
                self.assertEqual(self.github.calls, [self.exhausted_posted()])

    def test_the_exhausted_notice_goes_to_the_issue_without_an_open_pull_request(self):
        for name, issue in {"no pull request": ISSUE, "a closed one": self.with_pull(open_=False)}.items():
            with self.subTest(name):
                self.build()
                self.publisher.post_notice(issue, "fix-rounds-exhausted")
                self.assertEqual(self.github.calls, [self.exhausted_posted(12)])

    def test_the_other_notices_go_to_the_issue_even_with_an_open_pull_request(self):
        self.publisher.post_notice(self.with_pull(), "needs-app")
        self.assertEqual(self.github.calls, [self.POSTED])

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


def pull_request_run_result(**changes) -> dict:
    """A done result of a fix or revise run, which opens no pull request and so has no text for one."""
    return {name: value for name, value in done_result().items() if name != "pull_request"} | changes


def reply(thread: str, body: str, resolved: bool = False) -> dict:
    return {"thread_id": thread, "body": body, "resolved": resolved}


def reply_path(comment_id: int) -> str:
    return f"/repos/owner/name/pulls/{PULL}/comments/{comment_id}/replies"


class FixRunTest(PublishTestCase):
    stage = "fix"
    request_extra = {"round": 2, "pull_request": PULL}

    def assertCommentedOnThePullRequest(self) -> dict:
        self.assertEqual(self.writes("POST", self.comments), [])
        [posted] = self.writes("POST", self.pull_comments)
        return posted

    def test_a_done_run_pushes_to_the_existing_branch_and_comments_on_the_pull_request(self):
        self.branch_on_github(self.base)
        self.finish(result=pull_request_run_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.assertEqual(self.publish(), "done")
        self.assertEqual(self.remote_branch(), self.work_head)
        self.assertEqual(self.writes("POST", self.pulls), [])
        self.assertEqual([call for call in self.github.calls if call[0] == "PATCH"], [])
        self.assertEqual(self.writes("POST", f"{self.github.repo}/issues/{PULL}/labels"), [])
        posted = self.assertCommentedOnThePullRequest()
        self.assertEqual(markers.parse(posted["body"]), {
            "kind": "run", "job": self.job, "stage": "fix", "outcome": "done", "round": 2, "head": self.work_head})
        self.assertIn("round 2", posted["body"])
        self.assertNotIn("Pull request:", posted["body"])  # the comment is on that pull request already
        self.assertNotIn("No commit was pushed", posted["body"])
        self.assertEqual(self.github.posted(self.labels), {"labels": ["status:building"]})
        self.assertEqual(self.spool.state(self.job), "closed")

    def test_a_done_run_without_commits_pushes_nothing_and_names_the_unchanged_head(self):
        self.finish(result=pull_request_run_result())
        with mock.patch("factory.gitops.push") as push:
            self.assertEqual(self.publish(), "done")
        push.assert_not_called()
        self.assertIsNone(self.remote_branch())
        marker = markers.parse(self.assertCommentedOnThePullRequest()["body"])
        self.assertEqual((marker["outcome"], marker["head"], marker["round"]), ("done", self.base, 2))
        self.assertIn("No commit was pushed, so the branch is unchanged.", self.github.posted(self.pull_comments)["body"])
        self.assertEqual(self.github.posted(self.labels), {"labels": ["status:building"]})

    def test_a_pull_request_text_in_the_result_replaces_the_existing_text(self):
        self.finish(result=pull_request_run_result(pull_request={"title": "Fix it again", "body": "Round two."}))
        self.assertEqual(self.publish(), "done")
        [patched] = self.writes("PATCH", f"{self.pulls}/{PULL}")
        self.assertEqual(patched["title"], compose.pull_request_title("Fix it again"))
        self.assertTrue(patched["body"].startswith("Closes #12\n"))
        self.assertIn("Round two.", patched["body"])
        self.assertEqual(self.writes("POST", self.pulls), [])
        self.assertEqual(self.settled()["pull_request"], {"title": "Fix it again", "body": "Round two."})

    def test_a_repeat_after_the_pull_request_text_was_replaced_replaces_it_again_and_comments_once(self):
        self.finish(result=pull_request_run_result(pull_request={"title": "Fix it again", "body": "Round two."}))
        self.github.fail_once.add(("POST", self.pull_comments))
        with self.assertRaises(GitHubError):
            self.publish()
        self.assertEqual(self.publish(), "done")
        self.assertEqual(len(self.writes("POST", self.pull_comments)), 1)
        self.assertEqual(self.spool.state(self.job), "closed")

    def test_the_text_of_a_pull_request_another_account_opened_is_left_alone(self):
        authors = {"another login": ("someone", 99), "the bot's login with another id": (BOT.login, 77)}
        for name, (login, user_id) in authors.items():
            with self.subTest(name):
                self.build()
                self.github.answers[key(self.pull_path, {})] = {
                    "number": PULL, "user": {"login": login, "id": user_id}}
                self.finish(result=pull_request_run_result(pull_request={"title": "Mine now", "body": "Round two."}))
                self.assertEqual(self.publish(), "done")
                self.assertEqual([call for call in self.github.calls if call[0] == "PATCH"], [])
                self.assertEqual(len(self.writes("POST", self.pull_comments)), 1)

    def test_a_work_branch_that_is_gone_from_github_is_not_created_again(self):
        self.finish(result=pull_request_run_result(), bundle=self.bundle_of(GOOD_CHANGE))  # the branch is missing
        with mock.patch("factory.gitops.push") as push:
            self.assertEqual(self.publish(), "rejected")
        push.assert_not_called()
        self.assertIsNone(self.remote_branch())
        self.assertIn(f"- {BRANCH_MOVED}", self.assertCommentedOnThePullRequest()["body"])
        self.assertIsNone(self.settled()["head_sha"])
        self.assertNeedsAPerson()

    def test_threads_are_not_read_for_a_fix_run(self):
        self.finish(result=pull_request_run_result())
        with mock.patch.object(self.spool, "read_job_json", wraps=self.spool.read_job_json) as read:
            self.assertEqual(self.publish(), "done")
        self.assertNotIn("threads.json", [call.args[1] for call in read.call_args_list])

    def test_needs_input_and_failures_comment_on_the_pull_request_and_need_a_person(self):
        cases = {"needs_input": needs_input_result(), "failed": failed_result(), "timeout": None}
        for outcome, result in cases.items():
            with self.subTest(outcome):
                self.build()
                if result is None:
                    self.finish(status="timeout")
                else:
                    self.finish(result=result)
                self.assertEqual(self.publish(), outcome)
                marker = markers.parse(self.assertCommentedOnThePullRequest()["body"])
                self.assertEqual((marker["stage"], marker["outcome"], marker["round"]), ("fix", outcome, 2))
                self.assertNotIn("head", marker)
                self.assertNeedsAPerson()

    def test_a_done_run_whose_commits_are_refused_is_rejected_on_the_pull_request(self):
        self.finish(result=pull_request_run_result(), bundle=self.bundle_of(PROTECTED_CHANGE))
        self.assertEqual(self.publish(), "rejected")
        self.assertIsNone(self.remote_branch())
        self.assertIn("README.md, which is outside the writable paths", self.assertCommentedOnThePullRequest()["body"])
        self.assertNeedsAPerson()

    def test_a_run_without_a_pull_request_is_an_unusable_request_before_anything_is_written(self):
        self.finish(result=pull_request_run_result())
        self.rewrite_request(pull_request=0)
        with self.assertRaises(SpoolError):
            self.publish()
        with self.assertRaises(SpoolError):
            self.publisher.give_up(self.job, ISSUE, NOW)
        self.assertEqual(self.github.calls, [])
        self.assertIsNone(self.settled())
        self.assertEqual(self.spool.state(self.job), "finished")

    def test_giving_up_comments_on_the_pull_request(self):
        self.finish(result=pull_request_run_result())
        self.assertEqual(self.publisher.give_up(self.job, ISSUE, NOW), "crashed")
        marker = markers.parse(self.assertCommentedOnThePullRequest()["body"])
        self.assertEqual((marker["stage"], marker["outcome"], marker["round"]), ("fix", "crashed", 2))
        self.assertNeedsAPerson()


class StageFromTheRequestTest(PublishTestCase):
    def test_the_stage_the_round_and_the_pull_request_come_from_the_request(self):
        self.rewrite_request(stage="revise", skill="factory-revise", round=3, pull_request=PULL)
        self.finish(result=pull_request_run_result(thread_replies=[]))
        self.assertEqual(self.publish(), "done")  # the job's own name says fix_issue
        [posted] = self.writes("POST", self.pull_comments)
        marker = markers.parse(posted["body"])
        self.assertEqual((marker["stage"], marker["round"]), ("revise", 3))
        self.assertEqual(self.writes("POST", self.comments), [])

    def test_a_result_is_valid_only_for_the_stage_of_the_request(self):
        self.finish(result=done_result(thread_replies=[]))  # replies belong to a revise run, and this one is fix_issue
        self.assertEqual(self.publish(), "crashed")
        self.assertIn(compose.REASON_WORDS["agent_error"], self.comment())

    def test_a_fix_issue_run_names_the_pushed_head_when_it_is_done_and_none_otherwise(self):
        self.finish(result=done_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.publish()
        self.assertEqual(markers.parse(self.comment())["head"], self.work_head)
        self.build()
        self.finish(result=needs_input_result(), bundle=self.bundle_of(GOOD_CHANGE))
        self.publish()
        self.assertNotIn("head", markers.parse(self.comment()))


class ReviseRunTest(PublishTestCase):
    stage = "revise"
    request_extra = {"pull_request": PULL}
    github_class = ReviewingGitHub

    def build(self, config: factory_config.Config = CONFIG) -> None:
        super().build(config)
        self.spool.write_job_json(self.job, "threads.json", {"T1": 501, "T2": 502})
        self.github.graphql_answers = [{"resolveReviewThread": {"thread": {"isResolved": True}}}] * 20

    def run_with(self, replies: list, **changes) -> str:
        self.branch_on_github(self.base)
        self.finish(result=pull_request_run_result(thread_replies=replies, **changes),
                    bundle=self.bundle_of(GOOD_CHANGE))
        return self.publish()

    def resolved(self) -> list:
        return [variables["id"] for query, variables in self.github.graphql_calls if "resolveReviewThread" in query]

    def reply_markers(self) -> list:
        return [markers.parse(call[2]["body"]) for call in self.github.calls
                if call[0] == "POST" and REPLY_PATH.fullmatch(call[1])]

    def test_one_reply_per_known_thread_and_only_the_resolved_ones_are_resolved(self):
        replies = [reply("T1", "Renamed it.", True), reply("T2", "Left as it is, on purpose."),
                   reply("T9", "No such thread.", True)]
        self.assertEqual(self.run_with(replies), "done")
        [first] = self.writes("POST", reply_path(501))
        [second] = self.writes("POST", reply_path(502))
        self.assertTrue(first["body"].startswith(compose.thread_reply("Renamed it.", job_id=self.job, thread_id="T1")))
        self.assertTrue(second["body"].startswith(
            compose.thread_reply("Left as it is, on purpose.", job_id=self.job, thread_id="T2")))
        self.assertEqual(markers.parse(first["body"]), {"kind": "reply", "job": self.job, "thread": "T1"})
        self.assertEqual(markers.parse(second["body"]), {"kind": "reply", "job": self.job, "thread": "T2"})
        self.assertEqual(len([call for call in self.github.calls if REPLY_PATH.fullmatch(call[1])]), 2)
        self.assertEqual(self.resolved(), ["T1"])
        [posted] = self.writes("POST", self.pull_comments)
        self.assertEqual(markers.parse(posted["body"])["stage"], "revise")
        self.assertNotIn("round", markers.parse(posted["body"]))
        self.assertEqual(self.github.posted(self.labels), {"labels": ["status:building"]})

    def test_the_run_comment_is_the_last_write_of_the_pull_request(self):
        self.run_with([reply("T1", "Done.", True), reply("T2", "Also done.")])
        ours = [step for step in self.github.sequence if f"/{PULL}/" in step[1] or step[0] == "GRAPHQL"]
        self.assertEqual(ours, [("POST", reply_path(501)), ("GRAPHQL", "T1"), ("POST", reply_path(502)),
                                ("POST", self.pull_comments)])

    def test_a_reply_with_a_planted_marker_or_mention_is_neutral_and_ends_in_the_real_marker(self):
        planted = markers.encode({"kind": "run", "job": self.job, "stage": "revise", "outcome": "failed"})
        self.run_with([reply("T1", f"Thanks @someone, fixes #3. {planted}")])
        [posted] = self.writes("POST", reply_path(501))
        self.assertEqual(posted["body"].count(markers.PREFIX), 1)
        self.assertEqual(markers.parse(posted["body"]), {"kind": "reply", "job": self.job, "thread": "T1"})
        self.assertNotIn("@someone", posted["body"])
        self.assertNotIn("fixes #3", posted["body"])

    def test_a_blank_reply_posts_nothing_but_its_resolution_is_honoured(self):
        self.run_with([reply("T1", "   \n ", True)])
        self.assertEqual(self.writes("POST", reply_path(501)), [])
        self.assertEqual(self.resolved(), ["T1"])
        self.assertEqual(len(self.writes("POST", self.pull_comments)), 1)

    def test_replies_are_posted_only_for_a_done_run(self):
        self.finish(result=needs_input_result(thread_replies=[reply("T1", "Done.", True)]))
        self.assertEqual(self.publish(), "needs_input")
        self.assertEqual([call for call in self.github.calls if REPLY_PATH.fullmatch(call[1])], [])
        self.assertEqual(self.github.graphql_calls, [])
        self.assertEqual(self.settled()["replies"], [])
        self.assertNeedsAPerson()

    def test_without_a_readable_thread_list_there_is_nothing_to_reply_to(self):
        damages = {"missing": None, "not JSON": b"{not json", "a list": b"[]", "too large": b" " * 2_000_000,
                   "a comment id that is no number": json.dumps({"T1": "501"}).encode()}
        for name, damage in damages.items():
            with self.subTest(name):
                self.build()
                if damage is None:
                    self.spool.job_file(self.job, "threads.json").unlink()
                else:
                    self.spool.job_file(self.job, "threads.json").write_bytes(damage)
                self.assertEqual(self.run_with([reply("T1", "Done.", True)]), "done")
                self.assertEqual([call for call in self.github.calls if REPLY_PATH.fullmatch(call[1])], [])
                self.assertEqual(self.github.graphql_calls, [])
                self.assertEqual(len(self.writes("POST", self.pull_comments)), 1)

    def test_the_replies_are_stored_before_the_first_write(self):
        self.branch_on_github(self.base)
        self.finish(result=pull_request_run_result(thread_replies=[reply("T1", "Done.", True), reply("T9", "No.")]),
                    bundle=self.bundle_of(GOOD_CHANGE))
        unreachable = dataclasses.replace(self.publisher, push_url=str(self.tmp / "no-such-remote.git"))
        with self.assertRaises(GitError):
            unreachable.publish(self.job, ISSUE, NOW)
        self.assertEqual(self.settled()["replies"],
                         [{"thread": "T1", "comment_id": 501, "text": "Done.", "resolved": True}])
        self.assertEqual(self.github.calls, [])

    def test_a_repeat_after_an_interruption_at_each_write_posts_every_reply_once(self):
        replies = [reply("T1", "First.", True), reply("T2", "Second.")]
        writes = {
            "the first reply": ("POST", reply_path(501)),
            "the second reply, after the first was posted and resolved": ("POST", reply_path(502)),
            "the run comment, after every reply": ("POST", self.pull_comments),
            "the status label, after the run comment": ("POST", self.labels),
        }
        for name, write in writes.items():
            with self.subTest(name):
                self.build()
                self.branch_on_github(self.base)
                self.finish(result=pull_request_run_result(thread_replies=replies),
                            bundle=self.bundle_of(GOOD_CHANGE))
                self.github.fail_once.add(write)
                with self.assertRaises(GitHubError):
                    self.publish()
                self.assertEqual(self.spool.state(self.job), "finished")
                self.assertEqual(self.publish(), "done")
                self.assertEqual([len(self.writes("POST", reply_path(number))) for number in (501, 502)], [1, 1])
                self.assertEqual(len(self.writes("POST", self.pull_comments)), 1)
                self.assertEqual(set(self.resolved()), {"T1"})
                self.assertEqual(self.spool.state(self.job), "closed")

    def test_a_work_branch_that_is_gone_from_github_is_not_created_again_by_a_revise_run(self):
        self.finish(result=pull_request_run_result(thread_replies=[reply("T1", "Done.", True)]),
                    bundle=self.bundle_of(GOOD_CHANGE))  # the branch is missing
        with mock.patch("factory.gitops.push") as push:
            self.assertEqual(self.publish(), "rejected")
        push.assert_not_called()
        self.assertEqual(self.github.graphql_calls, [])
        self.assertEqual([call for call in self.github.calls if REPLY_PATH.fullmatch(call[1])], [])
        self.assertNeedsAPerson()

    def test_two_entries_for_one_thread_give_one_reply_the_first(self):
        self.run_with([reply("T1", "First answer.", False), reply("T1", "Second answer.", True)])
        [posted] = self.writes("POST", reply_path(501))
        self.assertIn("First answer.", posted["body"])
        self.assertEqual(self.resolved(), [])

    def test_known_threads_beyond_the_limit_are_cut_and_a_repeat_loads_the_stored_decision(self):
        threads = {f"T{number}": 1000 + number for number in range(MAX_REPLIES + 1)}
        self.spool.write_job_json(self.job, "threads.json", threads)
        replies = [reply(thread, "Done.") for thread in threads]
        self.branch_on_github(self.base)
        self.finish(result=pull_request_run_result(thread_replies=replies), bundle=self.bundle_of(GOOD_CHANGE))
        self.github.fail_once.add(("POST", self.pull_comments))
        with self.assertRaises(GitHubError):
            self.publish()
        self.assertEqual(len(self.settled()["replies"]), MAX_REPLIES)
        self.spool.job_file(self.job, "threads.json").write_text("{}")  # a repeat must not read the file again
        self.assertEqual(self.publish(), "done")
        posts = [call for call in self.github.calls if REPLY_PATH.fullmatch(call[1])]
        self.assertEqual(len(posts), MAX_REPLIES)
        self.assertEqual(len({call[1] for call in posts}), MAX_REPLIES)

    def test_entries_of_the_thread_list_that_are_not_a_thread_and_a_comment_are_dropped(self):
        self.spool.write_job_json(self.job, "threads.json", {
            "B": True, "S": "502", "bad key!": 503, "": 504, "Z": 0, "N": -3, "T1": 501})
        replies = [reply(thread, "Done.") for thread in ("B", "S", "bad key!", "Z", "N", "T1")]
        self.assertEqual(self.run_with(replies), "done")
        self.assertEqual([call[1] for call in self.github.calls if REPLY_PATH.fullmatch(call[1])], [reply_path(501)])

    def test_a_reply_whose_comment_or_thread_is_gone_is_skipped_and_the_publish_goes_on(self):
        for status in (404, 422):
            with self.subTest(status=status):
                self.build()
                self.github.refuse[("POST", reply_path(501))] = status
                replies = [reply("T1", "First.", True), reply("T2", "Second.", True)]
                self.assertEqual(self.run_with(replies), "done")
                self.assertEqual(len(self.writes("POST", reply_path(502))), 1)
                # A thread whose reply could not be posted stays open: resolving it would hide an unanswered thread.
                self.assertEqual(self.resolved(), ["T2"])
                self.assertEqual(len(self.writes("POST", self.pull_comments)), 1)
                self.assertEqual(self.spool.state(self.job), "closed")

    def test_any_other_failure_of_a_reply_is_raised_and_retried(self):
        self.github.refuse[("POST", reply_path(501))] = 500
        with self.assertRaises(GitHubError):
            self.run_with([reply("T1", "First.")])
        self.assertEqual(self.writes("POST", self.pull_comments), [])
        self.assertEqual(self.spool.state(self.job), "finished")

    def test_a_resolution_github_refuses_in_its_answer_is_skipped_but_a_failed_request_is_not(self):
        self.github.graphql_answers.insert(0, GraphQLRefused(0, "refused", ("NOT_FOUND",)))
        self.assertEqual(self.run_with([reply("T1", "First.", True), reply("T2", "Second.", True)]), "done")
        self.assertEqual(self.resolved(), ["T1", "T2"])
        for error in (GitHubError(502, "POST /graphql failed"),
                      GraphQLRefused(0, "refused", ("RATE_LIMITED",)),  # a refusal that may pass later is retried
                      GraphQLRefused(0, "refused", ("NOT_FOUND", "FORBIDDEN")),
                      GraphQLRefused(0, "refused"),
                      GitHubError(0, "POST /graphql failed with 1 error"),  # the wording alone decides nothing
                      GitHubError(0, "POST /graphql failed on the network (OSError)")):
            with self.subTest(error=error.message):
                self.build()
                self.github.graphql_answers.insert(0, error)
                with self.assertRaises(GitHubError):
                    self.run_with([reply("T1", "First.", True)])
                self.assertEqual(self.writes("POST", self.pull_comments), [])

    def test_a_repeat_after_an_interruption_at_the_push_the_text_or_the_close_finishes_everything_once(self):
        replies = [reply("T1", "First.", True), reply("T2", "Second.")]
        text = {"title": "Revised", "body": "Round."}

        def interrupt_push(test):
            unreachable = dataclasses.replace(test.publisher, push_url=str(test.tmp / "no-such-remote.git"))
            with test.assertRaises(GitError):
                unreachable.publish(test.job, ISSUE, NOW)

        def interrupt_text(test):
            test.github.fail_once.add(("PATCH", test.pull_path))
            with test.assertRaises(GitHubError):
                test.publish()

        def interrupt_close(test):
            with mock.patch.object(test.spool, "close", side_effect=SpoolError("closed.json cannot be written")), \
                    test.assertRaises(SpoolError):
                test.publish()

        for name, interrupt in {"the push": interrupt_push, "the pull request's text": interrupt_text,
                                "the close": interrupt_close}.items():
            with self.subTest(name):
                self.build()
                self.branch_on_github(self.base)
                self.finish(result=pull_request_run_result(thread_replies=replies, pull_request=text),
                            bundle=self.bundle_of(GOOD_CHANGE))
                interrupt(self)
                self.assertEqual(self.spool.state(self.job), "finished")
                self.assertEqual(self.publish(), "done")
                self.assertEqual(self.remote_branch(), self.work_head)
                self.assertEqual([len(self.writes("POST", reply_path(number))) for number in (501, 502)], [1, 1])
                self.assertEqual(len(self.writes("POST", self.pull_comments)), 1)
                self.assertEqual(self.spool.state(self.job), "closed")

    def test_a_repeat_after_a_resolution_that_failed_resolves_again_and_replies_once(self):
        self.github.graphql_answers.insert(0, GitHubError(502, "POST /graphql failed"))
        with self.assertRaises(GitHubError):
            self.run_with([reply("T1", "First.", True), reply("T2", "Second.")])
        self.assertEqual(self.publish(), "done")
        self.assertEqual([len(self.writes("POST", reply_path(number))) for number in (501, 502)], [1, 1])
        self.assertEqual(self.resolved(), ["T1", "T1"])
        self.assertEqual(len(self.writes("POST", self.pull_comments)), 1)

    def test_a_reply_this_job_already_posted_is_not_posted_again_but_is_resolved(self):
        mine = compose.thread_reply("First.", job_id=self.job, thread_id="T1")
        self.github.answers[key(self.review_comments, ALL_COMMENTS)] = [comment_json(9, BOT.login, BOT.user_id, mine)]
        self.run_with([reply("T1", "First.", True)])
        self.assertEqual(self.writes("POST", reply_path(501)), [])
        self.assertEqual(self.resolved(), ["T1"])

    def test_a_marker_of_someone_else_or_of_another_job_or_thread_does_not_suppress_a_reply(self):
        other_job = new_job_id("revise", 12, NOW)
        cases = {
            "another login": (("someone", BOT.user_id), self.job, "T1"),
            "another id": ((BOT.login, 77), self.job, "T1"),
            "another job": ((BOT.login, BOT.user_id), other_job, "T1"),
            "another thread": ((BOT.login, BOT.user_id), self.job, "T2"),
        }
        for name, ((login, user_id), job, thread) in cases.items():
            with self.subTest(name):
                self.build()
                planted = "text\n\n" + markers.encode({"kind": "reply", "job": job, "thread": thread})
                self.github.answers[key(self.review_comments, ALL_COMMENTS)] = [
                    comment_json(9, login, user_id, planted)]
                self.run_with([reply("T1", "First.")])
                self.assertEqual(len(self.writes("POST", reply_path(501))), 1)

    def test_a_finding_in_a_reply_blocks_publication_and_the_text_is_not_posted(self):
        self.assertEqual(self.run_with([reply("T1", f"Tested with the key {KEY} today.", True)]), "rejected")
        self.assertIsNone(self.remote_branch())
        self.assertEqual([call for call in self.github.calls if REPLY_PATH.fullmatch(call[1])], [])
        self.assertEqual(self.github.graphql_calls, [])
        [posted] = self.writes("POST", self.pull_comments)
        self.assertIn("- the result's text contains possible provider key", posted["body"])
        self.assertNotIn(KEY[:12], json.dumps([written for _, _, written in self.github.calls]))
        self.assertNeedsAPerson()

    def test_a_finding_in_the_reply_of_an_unknown_thread_blocks_publication_too(self):
        self.assertEqual(self.run_with([reply("T9", f"At {PRIVATE_ADDRESS}")]), "rejected")
        self.assertEqual(self.github.graphql_calls, [])


PULL_NODE = "PR_node"
HEAD = "a" * 40


def handoff_issue(**changes) -> Issue:
    pull = PullRequest(PULL, True, False, f"https://github.com/owner/name/pull/{PULL}", draft=True, head_sha=HEAD,
                       node_id=PULL_NODE, verdict="pass")
    return dataclasses.replace(ISSUE, pull_request=dataclasses.replace(pull, **changes))


class HandOffTest(PublishTestCase):
    github_class = ReviewingGitHub

    def setUp(self):
        super().setUp()
        self.pull = f"{self.github.repo}/pulls/{PULL}"
        self.reviewers = f"{self.pull}/requested_reviewers"
        self.github.graphql_answers = [{"markPullRequestReadyForReview": {"pullRequest": {"isDraft": False}}}] * 5
        self.fresh(draft=True)

    def fresh(self, *, state: str = "open", draft: bool = False, head: str = HEAD) -> None:
        """GitHub's answer for the pull request now."""
        self.github.answers[key(self.pull, {})] = {
            "number": PULL, "state": state, "draft": draft, "head": {"sha": head}, "node_id": PULL_NODE}

    def hand_off(self, issue: Issue | None = None) -> None:
        self.publisher.hand_off(issue or handoff_issue())

    def handoff_comments(self) -> list:
        return self.writes("POST", self.pull_comments)

    def test_it_marks_the_pull_request_ready_asks_the_person_and_comments_last(self):
        self.hand_off()
        [(query, variables)] = self.github.graphql_calls
        self.assertIn("markPullRequestReadyForReview", query)
        self.assertEqual(variables, {"id": PULL_NODE})
        self.assertEqual(self.writes("POST", self.reviewers), [{"reviewers": ["Marfusios"]}])
        [comment] = self.handoff_comments()
        self.assertEqual(comment["body"], compose.handoff_comment(HEAD, "pass"))
        self.assertEqual([path for _, path, _ in self.github.calls], [self.reviewers, self.pull_comments])

    def test_a_repeat_after_the_comment_does_none_of_it_again(self):
        self.hand_off()
        self.fresh(draft=False)
        calls, graphql = list(self.github.calls), list(self.github.graphql_calls)
        self.hand_off()
        self.assertEqual(self.github.calls, calls)
        self.assertEqual(self.github.graphql_calls, graphql)

    def test_a_hand_off_interrupted_before_its_comment_is_completed_by_the_next_call(self):
        self.github.fail_once.add(("POST", self.pull_comments))
        with self.assertRaises(GitHubError):
            self.hand_off()
        self.assertEqual(self.handoff_comments(), [])
        self.fresh(draft=False)  # the pull request was marked ready by the first call
        self.hand_off()
        self.assertEqual(len(self.github.graphql_calls), 1)  # not marked ready again
        self.assertEqual(len(self.handoff_comments()), 1)

    def test_a_pull_request_that_is_not_a_draft_is_not_marked_ready(self):
        self.fresh(draft=False)
        self.hand_off()
        self.assertEqual(self.github.graphql_calls, [])
        self.assertEqual(len(self.handoff_comments()), 1)

    def test_a_refused_review_request_does_not_stop_the_hand_off_but_another_error_does(self):
        self.github.refuse[("POST", self.reviewers)] = 422
        self.hand_off()
        self.assertEqual(self.github.refused, [("POST", self.reviewers)])
        self.assertEqual(len(self.handoff_comments()), 1)

        self.build()
        self.github.refuse[("POST", self.reviewers)] = 502
        self.github.graphql_answers = [{"markPullRequestReadyForReview": {}}] * 2
        self.fresh(draft=True)
        with self.assertRaises(GitHubError):
            self.hand_off()
        self.assertEqual(self.handoff_comments(), [])

    def test_a_person_outside_the_trusted_list_is_not_asked_for_a_review(self):
        self.hand_off(dataclasses.replace(handoff_issue(), trigger_actor="stranger"))
        self.assertEqual(len(self.github.graphql_calls), 1)
        self.assertEqual(self.writes("POST", self.reviewers), [])
        self.assertEqual(len(self.handoff_comments()), 1)

    def test_without_a_person_who_started_it_no_review_is_requested(self):
        self.hand_off(dataclasses.replace(handoff_issue(), trigger_actor=None))
        self.assertEqual(self.github.refused, [])
        self.assertEqual(self.writes("POST", self.reviewers), [])
        self.assertEqual(len(self.handoff_comments()), 1)

    def test_it_stops_before_any_write_when_the_pull_request_is_not_what_was_decided_on(self):
        cases = {
            "a pull request GitHub says is closed": (lambda: self.fresh(state="closed"), handoff_issue()),
            "a head that moved": (lambda: self.fresh(head="b" * 40), handoff_issue()),
            "a snapshot's pull request that is closed": (lambda: None, handoff_issue(open=False)),
            "a failing verdict": (lambda: None, handoff_issue(verdict="fail")),
        }
        for name, (arrange, issue) in cases.items():
            with self.subTest(name):
                self.build()
                self.github.graphql_answers = [{"markPullRequestReadyForReview": {}}]
                self.fresh(draft=True)
                arrange()
                self.hand_off(issue)
                self.assertEqual(self.github.calls, [])
                self.assertEqual(self.github.graphql_calls, [])

    def test_an_issue_without_a_pull_request_is_left_alone(self):
        self.hand_off(ISSUE)
        self.assertEqual(self.github.calls, [])

    def test_the_comment_says_no_second_model_read_the_commit_when_the_review_gave_no_verdict(self):
        self.hand_off(handoff_issue(verdict=""))
        [comment] = self.handoff_comments()
        self.assertEqual(comment["body"], compose.handoff_comment(HEAD, ""))
        self.assertIn("no second model", comment["body"])

    def test_a_hand_off_marker_of_someone_else_or_for_another_head_does_not_count(self):
        marked = compose.handoff_comment(HEAD, "pass")
        cases = {
            "another login": ("someone", BOT.user_id, marked),
            "another id": (BOT.login, 77, marked),
            "another head": (BOT.login, BOT.user_id, compose.handoff_comment("c" * 40, "pass")),
        }
        for name, (login, user_id, body) in cases.items():
            with self.subTest(name):
                self.build()
                self.github.graphql_answers = [{"markPullRequestReadyForReview": {}}]
                self.fresh(draft=True)
                self.github.answers[key(self.pull_comments, ALL_COMMENTS)] = [comment_json(5, login, user_id, body)]
                self.hand_off()
                self.assertEqual(len(self.handoff_comments()), 1)


if __name__ == "__main__":
    unittest.main()

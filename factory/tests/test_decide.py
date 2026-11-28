"""Tests for the decision function: one test per row of the situation table and per rule."""

import dataclasses
import unittest
from datetime import datetime, timezone

from factory import config as factory_config
from factory import compose, markers
from factory.decide import (
    CloseJob, HandOff, JobView, PostNotice, PublishRun, SetStatus, StartJob, decide, reviews_to_answer,
    revise_instruction,
)
from factory.snapshot import Bot, Check, Comment, Issue, PullRequest, Review, Snapshot

CONFIG = factory_config.load()
BOT = Bot("mk-factory[bot]", 4242)
NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
FUTURE = "2026-01-01T13:00:00Z"
PAST = "2026-01-01T11:00:00Z"
BUILDING, QUEUED, NEEDS_HUMAN, DONE = "status:building", "status:queued", "status:needs-human", "status:done"
CLOSE_REASON = "the issue is closed or no longer labelled"
HEAD = "0123456789abcdef0123456789abcdef01234567"
JOB_AT = "20260101T000000Z"  # the creation time a job id carries
JOB1 = f"{JOB_AT}-fix_issue-12-0a1b2c3d"
JOB0 = f"{JOB_AT}-fix_issue-12-0a1b2c3e"


def comment(id: int, body: str = "hello", author: str = "Marfusios") -> Comment:
    return Comment(id, author, 1, "2026-01-01T10:00:00Z", body)


def bot_comment(id: int, body: str) -> Comment:
    return Comment(id, BOT.login, BOT.user_id, "2026-01-01T10:00:00Z", body)


def marker_comment(
    id: int, outcome: str, *, stage: str = "fix_issue", round: int = 0, job_at: str = JOB_AT, job_id: str | None = None,
    retry_at: str = "",
) -> Comment:
    """A run's comment exactly as the factory writes it (`compose.run_comment`), so `decide` reads a real marker."""
    body = compose.run_comment(
        job_id=job_id or f"{job_at}-{stage}-12-{id:08x}", stage=stage, outcome=outcome, duration_seconds=60,
        model="opus", retry_at=retry_at, round=round,
    )
    return bot_comment(id, body)


def odd_marker_comment(id: int, data: dict) -> Comment:
    """A comment of the bot with a marker the factory does not write: whatever `data` says, nothing added."""
    return bot_comment(id, "Something happened.\n\n" + markers.encode(data))


def odd_run_comment(id: int, outcome: object, **odd) -> Comment:
    """A run marker as the factory writes it, except for the fields given in `odd`, which may hold any value."""
    return odd_marker_comment(id, {"kind": "run", "job": f"{JOB_AT}-fix_issue-12-0a1b2c3d", "stage": "fix_issue",
                                   "outcome": outcome, **odd})


def notice_comment(id: int, key: str) -> Comment:
    return bot_comment(id, compose.notice(key))


def handoff_comment(id: int, head: str = HEAD) -> Comment:
    return bot_comment(id, compose.handoff_comment(head, "pass"))


def issue(
    number: int, *, author: str = "Marfusios", open: bool = True, labels: tuple[str, ...] = ("factory:fix",),
    trigger: str | None = "Marfusios", comments: tuple[Comment, ...] = (), pull: PullRequest | None = None,
) -> Issue:
    return Issue(number, "A title", "A body", author, open, labels, trigger, comments, pull)


def snap(*issues: Issue, halted: bool = False, apps: tuple[str, ...] = ("demo",)) -> Snapshot:
    return Snapshot(tuple(issues), halted, apps)


def pull(*, open: bool = False, merged: bool = False) -> PullRequest:
    return PullRequest(5, open, merged, "https://github.com/owner/repo/pull/5")


def run(*issues: Issue, jobs=(), halted: bool = False, apps: tuple[str, ...] = ("demo",)):
    return decide(snap(*issues, halted=halted, apps=apps), list(jobs), NOW, CONFIG, BOT)


def with_marker(number: int, outcome: str, *later: Comment, pr: PullRequest | None = None, **data) -> Issue:
    return issue(number, comments=(marker_comment(3, outcome, **data), *later), pull=pr)


STARTS_12 = [SetStatus(12, BUILDING, ()), StartJob(12, "demo")]
HUMAN_12 = [SetStatus(12, NEEDS_HUMAN, ())]
QUEUED_12 = [SetStatus(12, QUEUED, ())]


class StartTest(unittest.TestCase):
    def test_a_fresh_trusted_issue_starts(self):
        self.assertEqual(run(issue(12)), STARTS_12)

    def test_a_label_from_an_untrusted_actor_does_nothing(self):
        self.assertEqual(run(issue(12, trigger="stranger")), [])
        self.assertEqual(run(issue(12, trigger=None)), [])

    def test_one_job_at_a_time_queues_the_rest(self):
        self.assertEqual(run(issue(13), issue(12)), [*STARTS_12, SetStatus(13, QUEUED, ())])

    def test_an_active_job_blocks_every_start(self):
        for state in ("queued", "running"):
            with self.subTest(state=state):
                actions = run(issue(12), issue(13), jobs=[JobView("j", 13, state)])
                self.assertEqual(actions, [SetStatus(12, QUEUED, ()), SetStatus(13, BUILDING, ())])

    def test_a_finished_job_of_another_issue_blocks_starts_too(self):
        actions = run(issue(12), issue(13), jobs=[JobView("j", 12, "finished")])
        self.assertEqual(actions, [PublishRun("j", 12), SetStatus(13, QUEUED, ())])

    def test_a_naive_now_is_refused(self):
        with self.assertRaises(ValueError):
            decide(snap(issue(12)), [], datetime(2026, 1, 1, 12, 0, 0), CONFIG, BOT)

    def test_a_running_job_of_a_closed_issue_still_blocks_and_is_left_alone(self):
        actions = run(issue(12), issue(13, open=False), jobs=[JobView("j", 13, "running")])
        self.assertEqual(actions, QUEUED_12)

    def test_halt_and_pause_queue_instead_of_starting(self):
        self.assertEqual(run(issue(12), halted=True), QUEUED_12)
        paused = issue(12, labels=("factory:fix", "factory:pause"))
        self.assertEqual(run(paused), QUEUED_12)

    def test_a_paused_issue_does_not_hold_back_the_next_one(self):
        paused = issue(12, labels=("factory:fix", "factory:pause"))
        self.assertEqual(run(paused, issue(13)), [*QUEUED_12, SetStatus(13, BUILDING, ()), StartJob(13, "demo")])

    def test_an_issue_that_waits_for_a_person_does_not_take_the_start_slot(self):
        actions = run(issue(14), issue(12, comments=(marker_comment(3, "failed"),)), issue(13))
        self.assertEqual(
            actions, [SetStatus(12, NEEDS_HUMAN, ()), SetStatus(13, BUILDING, ()), StartJob(13, "demo"),
                      SetStatus(14, QUEUED, ())],
        )


class JobTest(unittest.TestCase):
    def test_a_finished_job_is_published_even_when_halted_or_paused(self):
        job = JobView("j", 12, "finished")
        self.assertEqual(run(issue(12), jobs=[job], halted=True), [PublishRun("j", 12)])
        paused = issue(12, labels=("factory:fix", "factory:pause"))
        self.assertEqual(run(paused, jobs=[job]), [PublishRun("j", 12)])

    def test_a_finished_job_wins_over_a_second_job_of_the_same_issue(self):
        jobs = [JobView("a", 12, "running"), JobView("b", 12, "finished"), JobView("c", 12, "finished")]
        self.assertEqual(run(issue(12), jobs=jobs), [PublishRun("b", 12)])

    def test_a_queued_or_running_job_shows_building_once(self):
        job = JobView("j", 12, "running")
        self.assertEqual(run(issue(12), jobs=[job]), [SetStatus(12, BUILDING, ())])
        building = issue(12, labels=("factory:fix", BUILDING))
        self.assertEqual(run(building, jobs=[job]), [])

    def test_jobs_of_closed_or_unlabelled_issues_are_closed_unless_running(self):
        jobs = [
            JobView("closed", 1, "queued"), JobView("gone", 2, "finished"), JobView("busy", 3, "running"),
            JobView("untrusted", 4, "queued"), JobView("live", 5, "queued"),
        ]
        issues = (issue(1, open=False), issue(3, open=False), issue(4, trigger="stranger"), issue(5))
        actions = run(*issues, jobs=jobs)
        closes = [CloseJob("closed", CLOSE_REASON), CloseJob("gone", CLOSE_REASON), CloseJob("untrusted", CLOSE_REASON)]
        self.assertEqual(actions[:3], closes)
        self.assertEqual([a for a in actions if isinstance(a, CloseJob)], closes)
        self.assertIn(SetStatus(5, BUILDING, ()), actions)


class SettlingTest(unittest.TestCase):
    """A job the dispatcher closed after publishing it, while GitHub's comment list may still lag."""

    CLOSED = JobView(JOB1, 12, "closed")

    def test_a_closed_job_whose_marker_is_not_visible_yet_means_no_actions(self):
        lagging = issue(12, comments=(marker_comment(3, "needs_input"), comment(4)))
        self.assertEqual(run(lagging, jobs=[self.CLOSED]), [])

    def test_once_its_marker_is_visible_the_table_applies_again(self):
        seen = issue(
            12, comments=(marker_comment(3, "needs_input"), comment(4), marker_comment(5, "needs_input", job_id=JOB1))
        )
        self.assertEqual(run(seen, jobs=[self.CLOSED]), HUMAN_12)

    def test_a_marker_of_another_job_does_not_end_the_settling(self):
        other = issue(12, comments=(marker_comment(3, "needs_input", job_id=JOB0), comment(4)))
        self.assertEqual(run(other, jobs=[self.CLOSED]), [])

    def test_a_marker_whose_job_is_not_a_string_counts_as_no_job_and_raises_nothing(self):
        for job in (["j1"], {"a": 1}, 5, None):
            with self.subTest(job=job):
                history = issue(12, comments=(odd_run_comment(3, "needs_input", job=job),))
                self.assertEqual(run(history), HUMAN_12)
                self.assertEqual(run(history, jobs=[self.CLOSED]), [])

    def test_a_fresh_issue_with_a_closed_job_does_not_start(self):
        self.assertEqual(run(issue(12), jobs=[self.CLOSED]), [])

    def test_a_settling_issue_blocks_every_start_for_this_poll(self):
        lagging = issue(12, comments=(marker_comment(3, "needs_input"),))
        self.assertEqual(run(lagging, issue(13), jobs=[self.CLOSED]), [SetStatus(13, QUEUED, ())])

    def test_once_its_marker_is_visible_a_closed_job_blocks_nothing(self):
        seen = issue(12, comments=(marker_comment(3, "usage_limit", job_id=JOB1, retry_at=PAST),))
        self.assertEqual(run(seen, issue(13), jobs=[self.CLOSED]),
                         [SetStatus(12, BUILDING, ()), StartJob(12, "demo"), SetStatus(13, QUEUED, ())])

    def test_a_closed_job_of_an_issue_that_is_not_handled_blocks_nothing(self):
        for other in (issue(12, open=False), issue(12, trigger="stranger"),
                      dataclasses.replace(issue(12, trigger=None), unreadable=True)):
            with self.subTest(other=other):
                self.assertEqual(run(other, issue(13), jobs=[self.CLOSED])[-2:],
                                 [SetStatus(13, BUILDING, ()), StartJob(13, "demo")])

    def test_a_closed_job_of_a_closed_or_unlabelled_issue_is_not_closed_again(self):
        self.assertEqual(run(issue(12, open=False), jobs=[self.CLOSED]), [])
        self.assertEqual(run(issue(12, trigger="stranger"), jobs=[self.CLOSED]), [])
        self.assertEqual(run(jobs=[self.CLOSED]), [])

    def test_a_live_job_is_still_handled_before_settling(self):
        jobs = [self.CLOSED, JobView("j2", 12, "finished")]
        self.assertEqual(run(issue(12), jobs=jobs), [PublishRun("j2", 12)])


class MarkerRowsTest(unittest.TestCase):
    def test_needs_input_waits_for_a_trusted_reply(self):
        self.assertEqual(run(with_marker(12, "needs_input")), HUMAN_12)
        self.assertEqual(run(with_marker(12, "needs_input", comment(4, author="stranger"))), HUMAN_12)
        self.assertEqual(run(with_marker(12, "needs_input", comment(4))), STARTS_12)

    def test_a_reply_before_the_marker_does_not_count(self):
        reply_first = issue(12, comments=(comment(2), marker_comment(3, "needs_input")))
        self.assertEqual(run(reply_first), HUMAN_12)

    def test_the_bots_own_comment_is_not_a_trusted_reply(self):
        later = Comment(4, BOT.login, BOT.user_id, "2026-01-01T10:00:00Z", "plain bot text")
        self.assertEqual(run(with_marker(12, "needs_input", later)), HUMAN_12)

    def test_failed_waits_for_factory_retry(self):
        for outcome in ("failed", "timeout", "crashed", "refused", "rejected"):
            with self.subTest(outcome=outcome):
                self.assertEqual(run(with_marker(12, outcome)), HUMAN_12)
                self.assertEqual(run(with_marker(12, outcome, comment(4, "thanks"))), HUMAN_12)
                self.assertEqual(run(with_marker(12, outcome, comment(4, "/factory retry"))), STARTS_12)

    def test_a_retry_before_the_marker_or_from_a_stranger_does_not_count(self):
        before = issue(12, comments=(comment(2, "/factory retry"), marker_comment(3, "failed")))
        self.assertEqual(run(before), HUMAN_12)
        stranger = with_marker(12, "failed", comment(4, "/factory retry", author="stranger"))
        self.assertEqual(run(stranger), HUMAN_12)

    def test_usage_limit_waits_for_its_time_and_blocks_other_issues(self):
        waiting = with_marker(12, "usage_limit", retry_at=FUTURE)
        self.assertEqual(run(waiting), QUEUED_12)
        self.assertEqual(run(waiting, issue(13)), [*QUEUED_12, SetStatus(13, QUEUED, ())])
        self.assertEqual(run(with_marker(12, "usage_limit", retry_at=PAST)), STARTS_12)
        self.assertEqual(run(with_marker(12, "usage_limit", retry_at=NOW.strftime("%Y-%m-%dT%H:%M:%SZ"))), STARTS_12)

    def test_an_unreadable_retry_time_counts_as_past(self):
        for retry_at in ("tomorrow", "2026-01-01 13:00:00", "2026-01-01T13:00:00+00:00", 5, None):
            with self.subTest(retry_at=retry_at):
                odd = issue(12, comments=(odd_run_comment(3, "usage_limit", retry_at=retry_at),))
                self.assertEqual(run(odd), STARTS_12)
        self.assertEqual(run(with_marker(12, "usage_limit")), STARTS_12)

    def test_a_usage_limit_of_an_untrusted_issue_blocks_nothing(self):
        waiting = issue(11, trigger="stranger", comments=(marker_comment(3, "usage_limit", retry_at=FUTURE),))
        self.assertEqual(run(waiting, issue(12)), STARTS_12)

    def test_a_past_usage_limit_does_not_block_other_issues(self):
        past = with_marker(11, "usage_limit", retry_at=PAST)
        self.assertEqual(run(past, issue(12)), [SetStatus(11, BUILDING, ()), StartJob(11, "demo"), SetStatus(12, QUEUED, ())])

    def test_done_with_an_open_pull_request_is_building_and_quiet(self):
        open_pull = pull(open=True)
        self.assertEqual(run(with_marker(12, "done", pr=open_pull)), [SetStatus(12, BUILDING, ())])
        building = issue(12, labels=("factory:fix", BUILDING), comments=(marker_comment(3, "done"),), pull=open_pull)
        self.assertEqual(run(building), [])

    def test_done_with_a_closed_pull_request_posts_the_notice_once(self):
        closed = with_marker(12, "done", pr=pull())
        self.assertEqual(run(closed), [PostNotice(12, "pr-closed"), SetStatus(12, NEEDS_HUMAN, ())])
        after_notice = issue(12, comments=(marker_comment(3, "done"), marker_comment(4, "failed")), pull=pull())
        self.assertEqual(run(after_notice), HUMAN_12)
        retried = issue(
            12, comments=(marker_comment(3, "done"), marker_comment(4, "failed"), comment(5, "/factory retry")),
            pull=pull(),
        )
        self.assertEqual(run(retried), STARTS_12)

    def test_done_without_a_pull_request_does_nothing(self):
        self.assertEqual(run(with_marker(12, "done")), [])

    def test_an_unknown_outcome_does_nothing(self):
        for outcome in ("mystery", "published", ["failed"]):
            with self.subTest(outcome=outcome):
                self.assertEqual(run(issue(12, comments=(odd_run_comment(3, outcome),))), [])
        self.assertEqual(run(issue(12, comments=(odd_marker_comment(3, {"job": "x"}),))), [])

    def test_a_marker_in_a_strangers_comment_changes_nothing(self):
        faked = dataclasses.replace(marker_comment(3, "failed"), author="stranger", author_id=9)
        self.assertEqual(run(issue(12, comments=(faked,))), STARTS_12)
        lookalike = dataclasses.replace(marker_comment(3, "failed"), author_id=1)
        self.assertEqual(run(issue(12, comments=(lookalike,))), STARTS_12)

    def test_only_the_last_marker_counts(self):
        two = issue(12, comments=(marker_comment(3, "failed"), marker_comment(4, "needs_input")))
        self.assertEqual(run(two), HUMAN_12)


class NoMarkerTest(unittest.TestCase):
    def test_a_merged_pull_request_means_done(self):
        self.assertEqual(run(issue(12, pull=pull(merged=True))), [SetStatus(12, DONE, ())])
        self.assertEqual(run(with_marker(12, "failed", pr=pull(merged=True))), [SetStatus(12, DONE, ())])

    def test_no_marker_with_an_open_pull_request_does_nothing(self):
        self.assertEqual(run(issue(12, pull=pull(open=True))), [])

    def test_no_marker_with_a_closed_unmerged_pull_request_is_like_no_marker_at_all(self):
        self.assertEqual(run(issue(12, pull=pull())), STARTS_12)
        stranger = issue(12, author="stranger", pull=pull())
        self.assertEqual(run(stranger), [PostNotice(12, "untrusted-author"), SetStatus(12, NEEDS_HUMAN, ())])

    def test_untrusted_author_without_trusted_comment_gets_the_notice(self):
        stranger = issue(12, author="stranger")
        self.assertEqual(run(stranger), [PostNotice(12, "untrusted-author"), SetStatus(12, NEEDS_HUMAN, ())])
        after = issue(12, author="stranger", comments=(marker_comment(3, "needs_input"),))
        self.assertEqual(run(after), HUMAN_12)

    def test_untrusted_author_with_a_trusted_comment_starts(self):
        self.assertEqual(run(issue(12, author="stranger", comments=(comment(2),))), STARTS_12)
        outsider = issue(12, author="stranger", comments=(comment(2, author="other"),))
        self.assertEqual(run(outsider), [PostNotice(12, "untrusted-author"), SetStatus(12, NEEDS_HUMAN, ())])

    def test_missing_app_gets_the_notice_and_a_reply_naming_it_starts(self):
        apps = ("alpha", "beta")
        self.assertEqual(run(issue(12), apps=apps), [PostNotice(12, "needs-app"), SetStatus(12, NEEDS_HUMAN, ())])
        asked = issue(12, comments=(marker_comment(3, "needs_input"),))
        self.assertEqual(run(asked, apps=apps), HUMAN_12)
        named = issue(12, comments=(marker_comment(3, "needs_input"), comment(4, "app: beta")))
        self.assertEqual(run(named, apps=apps), [SetStatus(12, BUILDING, ()), StartJob(12, "beta")])

    def test_a_missing_app_does_not_take_the_start_slot(self):
        actions = run(issue(12), issue(13), apps=("alpha", "beta"))
        self.assertEqual(
            actions,
            [PostNotice(12, "needs-app"), SetStatus(12, NEEDS_HUMAN, ()), PostNotice(13, "needs-app"),
             SetStatus(13, NEEDS_HUMAN, ())],
        )


class UnreadableTest(unittest.TestCase):
    """An open issue whose events, comments or pull request could not be read this poll."""

    @staticmethod
    def unreadable(number: int, **options) -> Issue:
        return dataclasses.replace(issue(number, trigger=None, **options), unreadable=True)

    def test_an_unreadable_issue_keeps_its_jobs_and_gets_no_actions(self):
        for state in ("queued", "running", "finished"):
            with self.subTest(state=state):
                actions = run(self.unreadable(12), jobs=[JobView("j", 12, state)])
                self.assertEqual(actions, [])

    def test_an_unreadable_issue_neither_starts_nor_holds_back_another(self):
        self.assertEqual(run(self.unreadable(12)), [])
        self.assertEqual(run(self.unreadable(12, labels=("factory:fix", NEEDS_HUMAN)), issue(13)),
                         [SetStatus(13, BUILDING, ()), StartJob(13, "demo")])


class ClosedIssueTest(unittest.TestCase):
    def test_closed_issues_get_done_or_lose_their_status(self):
        merged = issue(3, open=False, labels=("factory:fix", BUILDING), pull=pull(merged=True))
        unmerged = issue(2, open=False, labels=("factory:fix", BUILDING, QUEUED), pull=pull())
        self.assertEqual(
            run(merged, unmerged), [SetStatus(2, None, (BUILDING, QUEUED)), SetStatus(3, DONE, (BUILDING,))]
        )

    def test_closed_issues_come_before_open_ones(self):
        closed = issue(9, open=False, labels=("factory:fix", BUILDING))
        expected = [SetStatus(9, None, (BUILDING,)), SetStatus(1, BUILDING, ()), StartJob(1, "demo")]
        self.assertEqual(run(issue(1), closed), expected)

    def test_a_closed_issue_without_status_labels_is_left_alone(self):
        self.assertEqual(run(issue(9, open=False)), [])
        done = issue(9, open=False, labels=("factory:fix", DONE), pull=pull(merged=True))
        self.assertEqual(run(done), [])


class StatusTest(unittest.TestCase):
    def test_status_is_not_repeated_when_already_right(self):
        building = issue(12, labels=("factory:fix", BUILDING))
        self.assertEqual(run(building), [StartJob(12, "demo")])
        needs_human = issue(12, labels=("factory:fix", NEEDS_HUMAN), comments=(marker_comment(3, "failed"),))
        self.assertEqual(run(needs_human), [])

    def test_other_status_labels_are_removed_in_issue_order(self):
        crowded = issue(12, labels=("factory:fix", QUEUED, "other", NEEDS_HUMAN), comments=(marker_comment(3, "failed"),))
        self.assertEqual(run(crowded), [SetStatus(12, None, (QUEUED,))])

    def test_a_wanted_label_already_present_among_others_only_removes_the_rest(self):
        crowded = issue(12, labels=("factory:fix", QUEUED, BUILDING))
        self.assertEqual(run(crowded, halted=True), [SetStatus(12, None, (BUILDING,))])

    def test_a_missing_wanted_label_is_added_and_the_others_removed(self):
        crowded = issue(12, labels=("factory:fix", QUEUED, DONE))
        self.assertEqual(run(crowded), [SetStatus(12, BUILDING, (QUEUED, DONE)), StartJob(12, "demo")])


AFTER = "2026-01-01T10:30:00Z"  # later than the comments of these tests, which carry 10:00:00
BEFORE = "2026-01-01T09:00:00Z"
EARLY_JOB = "20260101T093000Z"  # the creation times a job id carries
LATE_JOB = "20260101T103000Z"


def checks_pull(state: str, *, draft: bool = False, reviews: tuple[Review, ...] = ()) -> PullRequest:
    """An open pull request whose required checks all read `state` ("passed", "failed" or "pending")."""
    checks = tuple(Check(name, state, index) for index, name in enumerate(CONFIG.dispatcher.required_checks))
    return PullRequest(5, True, False, "https://github.com/owner/repo/pull/5", draft, HEAD, "node", checks, True,
                       "", "", reviews)


def review(state: str, *, author: str = "Marfusios", at: str = AFTER, id: int = 1) -> Review:
    return Review(id, author, state, at, "Please change this.")


def stage_comment(id: int, stage: str, outcome: str = "done", **options) -> Comment:
    """A run of `stage` as the factory writes its comment; `round`, `job_at` and `retry_at` as `marker_comment`."""
    return marker_comment(id, outcome, stage=stage, **options)


def in_flight(pr: PullRequest, *comments: Comment) -> Issue:
    return issue(12, comments=comments, pull=pr)


def building_issue(pr: PullRequest, *comments: Comment) -> Issue:
    """The issue as the table leaves it while its pull request is in flight: status building already."""
    return issue(12, labels=("factory:fix", BUILDING), comments=comments, pull=pr)


def start(stage: str, round: int = 0) -> list:
    return [SetStatus(12, BUILDING, ()), StartJob(12, "demo", stage, round)]


class FixRowsTest(unittest.TestCase):
    def test_failed_checks_after_a_finished_run_start_the_next_fix_round(self):
        failed = checks_pull("failed")
        self.assertEqual(run(in_flight(failed, marker_comment(2, "done"))), start("fix", 1))
        for done in (1, 2):
            with self.subTest(done=done):
                self.assertEqual(run(in_flight(failed, stage_comment(3, "fix", round=done))), start("fix", done + 1))

    def test_failed_checks_after_the_last_round_post_the_notice(self):
        actions = run(in_flight(checks_pull("failed"), stage_comment(3, "fix", round=3)))
        self.assertEqual(actions, [PostNotice(12, "fix-rounds-exhausted"), SetStatus(12, NEEDS_HUMAN, ())])

    def test_a_fix_run_without_a_usable_round_fails_closed_to_the_notice(self):
        exhausted = [PostNotice(12, "fix-rounds-exhausted"), SetStatus(12, NEEDS_HUMAN, ())]
        self.assertEqual(run(in_flight(checks_pull("failed"), stage_comment(3, "fix"))), exhausted)  # no round written
        for odd in (True, 0, -1, 1001, "2", 2.0, [2]):
            with self.subTest(round=odd):
                marker = odd_run_comment(3, "done", stage="fix", round=odd)
                self.assertEqual(run(in_flight(checks_pull("failed"), marker)), exhausted)

    def test_once_the_notice_is_in_the_stream_nothing_more_happens(self):
        history = (stage_comment(3, "fix", round=3), notice_comment(4, "fix-rounds-exhausted"))
        self.assertEqual(run(in_flight(checks_pull("failed"), *history)), HUMAN_12)
        waiting = issue(12, labels=("factory:fix", NEEDS_HUMAN), comments=history, pull=checks_pull("failed"))
        self.assertEqual(run(waiting), [])

    def test_a_retry_after_the_notice_starts_fix_at_round_one(self):
        history = (stage_comment(3, "fix", round=3), notice_comment(4, "fix-rounds-exhausted"), comment(5, "/factory retry"))
        self.assertEqual(run(in_flight(checks_pull("failed"), *history)), start("fix", 1))

    def test_a_retry_after_three_failed_fix_runs_starts_round_one_and_the_next_round_is_two(self):
        failures = (stage_comment(3, "fix", round=1), stage_comment(4, "fix", round=2),
                    stage_comment(5, "fix", "failed", round=3))
        retried = in_flight(checks_pull("failed"), *failures, comment(6, "/factory retry"))
        self.assertEqual(run(retried), start("fix", 1))
        done = in_flight(checks_pull("failed"), *failures, comment(6, "/factory retry"), stage_comment(7, "fix", round=1))
        self.assertEqual(run(done), start("fix", 2))

    def test_after_a_revise_or_a_fix_issue_run_the_fix_rounds_start_at_one(self):
        for stage in ("revise", "fix_issue"):
            with self.subTest(stage=stage):
                history = (stage_comment(3, "fix", round=1), stage_comment(4, "fix", round=2), stage_comment(5, stage))
                self.assertEqual(run(in_flight(checks_pull("failed"), *history)), start("fix", 1))
        counted = (stage_comment(3, "fix", round=1), stage_comment(4, "revise"), stage_comment(5, "fix", round=1))
        self.assertEqual(run(in_flight(checks_pull("failed"), *counted)), start("fix", 2))

    def test_a_usage_limit_resumes_fix_with_its_own_round(self):
        resumed = stage_comment(3, "fix", "usage_limit", round=2, retry_at=PAST)
        self.assertEqual(run(in_flight(checks_pull("failed"), resumed)), start("fix", 2))
        unnumbered = stage_comment(3, "fix", "usage_limit", retry_at=PAST)  # no round written
        self.assertEqual(run(in_flight(checks_pull("failed"), unnumbered)), start("fix", 3))

    def test_pending_checks_do_nothing(self):
        self.assertEqual(run(in_flight(checks_pull("pending"), marker_comment(3, "done"))), [SetStatus(12, BUILDING, ())])
        self.assertEqual(run(building_issue(checks_pull("pending"), stage_comment(3, "fix", round=1))), [])

    def test_checks_of_an_older_head_are_pending_so_nothing_happens(self):
        stale = dataclasses.replace(checks_pull("failed"), head_sha="abc", checks=())
        self.assertEqual(run(building_issue(stale, stage_comment(3, "fix", round=1))), [])


class HandOffTest(unittest.TestCase):
    def test_passed_checks_on_a_draft_hand_the_pull_request_over(self):
        draft = checks_pull("passed", draft=True)
        self.assertEqual(run(building_issue(draft, marker_comment(3, "done"))), [HandOff(12)])
        self.assertEqual(run(building_issue(draft, stage_comment(3, "revise"))), [HandOff(12)])

    def test_passed_checks_after_a_run_on_a_ready_pull_request_hand_over_again(self):
        """After a revise round on a pull request a person already has, the person is asked to look again."""
        ready = checks_pull("passed")
        self.assertEqual(run(building_issue(ready, stage_comment(3, "revise"))), [HandOff(12)])
        self.assertEqual(run(building_issue(ready, stage_comment(3, "fix", round=1))), [HandOff(12)])

    def test_passed_checks_with_a_failing_verdict_hand_nothing_over(self):
        """The review check decides, so this pair is a contradiction: wait instead of handing over a failed review."""
        contradictory = dataclasses.replace(checks_pull("passed", draft=True), verdict="fail")
        self.assertEqual(run(building_issue(contradictory, marker_comment(3, "done"))), [])
        for verdict in ("pass", "unavailable", ""):
            with self.subTest(verdict=verdict):
                fine = dataclasses.replace(checks_pull("passed", draft=True), verdict=verdict)
                self.assertEqual(run(building_issue(fine, marker_comment(3, "done"))), [HandOff(12)])

    def test_a_job_in_flight_holds_the_hand_off_back(self):
        draft = in_flight(checks_pull("passed", draft=True), marker_comment(3, "done"))
        self.assertEqual(run(draft, jobs=[JobView("j", 12, "running")]), [SetStatus(12, BUILDING, ())])

    def test_a_review_submitted_during_a_fix_run_comes_before_the_hand_off(self):
        pr = checks_pull("passed", draft=True, reviews=(review("changes_requested"),))
        self.assertEqual(run(in_flight(pr, stage_comment(3, "fix", round=1))), start("revise"))


class AfterTheHandOffTest(unittest.TestCase):
    """The hand-off marker is the last marker: a person has the pull request, and only a person's asks start runs."""

    def test_a_trusted_review_starts_revise(self):
        pr = checks_pull("passed", reviews=(review("changes_requested"),))
        self.assertEqual(run(in_flight(pr, handoff_comment(3))), start("revise"))

    def test_the_revise_command_starts_revise(self):
        pr = checks_pull("passed")
        self.assertEqual(run(in_flight(pr, handoff_comment(3), comment(4, "/factory revise rename it"))),
                         start("revise"))

    def test_failing_checks_start_nothing(self):
        self.assertEqual(run(building_issue(checks_pull("failed"), handoff_comment(3))), [])

    def test_passing_checks_on_a_draft_again_hand_over_nothing(self):
        self.assertEqual(run(building_issue(checks_pull("passed", draft=True), handoff_comment(3))), [])

    def test_a_marker_of_a_kind_the_code_does_not_know_is_read_like_the_hand_off(self):
        pr = checks_pull("failed", reviews=(review("commented"),))
        future = odd_marker_comment(3, {"kind": "future"})
        self.assertEqual(run(in_flight(pr, future)), start("revise"))
        self.assertEqual(run(in_flight(checks_pull("failed"), future)), [])


class NeedsAppTest(unittest.TestCase):
    """A start held back for the app is decided again with its own stage once the app is named."""

    def test_a_fix_that_cannot_choose_an_app_asks_once_and_then_starts_as_a_fix(self):
        failed = checks_pull("failed")
        done = stage_comment(3, "fix", round=1)
        asked = run(in_flight(failed, done), apps=("alpha", "beta"))
        self.assertEqual(asked, [PostNotice(12, "needs-app"), SetStatus(12, NEEDS_HUMAN, ())])
        notice = notice_comment(4, "needs-app")
        waiting = run(in_flight(failed, done, notice), apps=("alpha", "beta"))
        self.assertEqual(waiting, HUMAN_12)
        answered = in_flight(failed, done, notice, comment(5, "app: demo"))
        self.assertEqual(run(answered, apps=("alpha", "demo")), start("fix", 2))

    def test_a_notice_with_no_run_before_it_keeps_todays_rows(self):
        notice = notice_comment(3, "needs-app")
        self.assertEqual(run(in_flight(checks_pull("failed"), notice, comment(4, "app: demo"))), STARTS_12)


class ReviseRowsTest(unittest.TestCase):
    def test_a_trusted_review_that_changes_or_comments_starts_revise_even_when_checks_failed(self):
        for state in ("changes_requested", "commented"):
            with self.subTest(state=state):
                pr = checks_pull("failed", reviews=(review(state),))
                self.assertEqual(run(in_flight(pr, stage_comment(3, "fix", round=1))), start("revise"))

    def test_a_review_that_does_not_count_starts_nothing(self):
        cases = {
            "untrusted": review("changes_requested", author="stranger"),
            "approval": review("approved"),
            "dismissed": review("dismissed"),
            "an unparseable time": review("changes_requested", at="2026-01-01 10:45:00"),
            "an empty time": review("changes_requested", at=""),
            "the time of a run that answered it": review("changes_requested", at="2026-01-01T10:15:00Z"),
            "the same second as the revise job": review("changes_requested", at="2026-01-01T10:30:00Z"),
        }
        for name, one in cases.items():
            with self.subTest(name):
                pr = checks_pull("pending", reviews=(one,))
                answered = stage_comment(3, "revise", job_at=LATE_JOB)
                self.assertEqual(run(building_issue(pr, answered)), [])

    def test_a_review_submitted_during_a_revise_run_starts_another_revise(self):
        pr = checks_pull("pending", reviews=(review("changes_requested", at="2026-01-01T10:45:00Z"),))
        self.assertEqual(run(in_flight(pr, stage_comment(3, "revise", job_at=LATE_JOB))), start("revise"))

    def test_the_review_that_started_a_revise_run_does_not_count_again_whatever_the_outcome(self):
        pr = checks_pull("failed", reviews=(review("changes_requested", at="2026-01-01T10:15:00Z"),))
        for outcome in ("done", "failed", "needs_input", "timeout"):
            with self.subTest(outcome=outcome):
                actions = run(in_flight(pr, stage_comment(3, "revise", outcome, job_at=LATE_JOB)))
                self.assertNotIn(StartJob(12, "demo", "revise", 0), actions)
        failed = run(in_flight(pr, stage_comment(3, "revise", "failed", job_at=LATE_JOB)))
        self.assertEqual(failed, HUMAN_12)

    def test_a_revise_marker_whose_job_id_does_not_parse_is_skipped(self):
        pr = checks_pull("pending", reviews=(review("changes_requested", at=BEFORE),))
        for job in ("nonsense", 5, None, ["x"], "20261301T093000Z-revise-12-0a1b2c3d", "20260101T093000Z-revise-12"):
            with self.subTest(job=job):
                marker = odd_run_comment(3, "done", stage="revise", job=job)
                self.assertEqual(run(in_flight(pr, marker)), start("revise"))

    def test_an_older_revise_job_is_ignored_for_a_newer_one(self):
        pr = checks_pull("pending", reviews=(review("changes_requested", at="2026-01-01T10:00:00Z"),))
        history = (stage_comment(3, "revise", job_at=EARLY_JOB), stage_comment(4, "revise", job_at=LATE_JOB))
        self.assertEqual(run(building_issue(pr, *history)), [])

    def test_a_review_arrived_while_usage_limited_wins_over_resuming_the_fix(self):
        pr = checks_pull("failed", reviews=(review("changes_requested"),))
        limited = stage_comment(3, "fix", "usage_limit", round=1, retry_at=PAST)
        self.assertEqual(run(in_flight(pr, limited)), start("revise"))
        waiting = stage_comment(3, "fix", "usage_limit", round=1, retry_at=FUTURE)
        self.assertEqual(run(in_flight(pr, waiting)), QUEUED_12)

    def test_a_review_starts_revise_after_a_fix_run_that_needs_input_too(self):
        pr = checks_pull("failed", reviews=(review("commented"),))
        self.assertEqual(run(in_flight(pr, stage_comment(3, "fix", "needs_input"))), start("revise"))

    def test_the_revise_command_starts_revise(self):
        pr = checks_pull("pending")
        self.assertEqual(run(in_flight(pr, stage_comment(3, "fix", round=1), comment(4, "/factory revise tidy"))),
                         start("revise"))
        self.assertEqual(run(in_flight(pr, stage_comment(3, "fix", round=1), comment(4, "/Factory Revise"))),
                         start("revise"))

    def test_a_command_written_during_a_fix_run_is_not_lost(self):
        pr = checks_pull("pending")
        early = Comment(2, "Marfusios", 1, BEFORE, "/factory revise rename it")
        self.assertEqual(run(in_flight(pr, early, stage_comment(3, "fix", round=1))), start("revise"))

    def test_the_revise_command_must_be_trusted_new_and_exact(self):
        pr = checks_pull("pending")
        fix = stage_comment(3, "fix", round=1)
        later_comments = {
            "stranger": comment(4, "/factory revise now", author="stranger"),
            "not the first line": comment(4, "hello\n/factory revise"),
            "another command": comment(4, "/factory revised"),
            "the bot": Comment(4, BOT.login, BOT.user_id, "2026-01-01T10:00:00Z", "/factory revise"),
        }
        for name, later in later_comments.items():
            with self.subTest(name):
                self.assertEqual(run(building_issue(pr, fix, later)), [])
        answered = stage_comment(5, "revise", job_at=LATE_JOB)
        older = Comment(2, "Marfusios", 1, BEFORE, "/factory revise")
        same_second = Comment(4, "Marfusios", 1, "2026-01-01T10:30:00Z", "/factory revise")
        unparseable = Comment(4, "Marfusios", 1, "yesterday", "/factory revise")
        for name, one in {"older": older, "same second": same_second, "unparseable": unparseable}.items():
            with self.subTest(name):
                self.assertEqual(run(building_issue(pr, one, answered)), [])
        unparseable_alone = building_issue(pr, unparseable, fix)
        self.assertEqual(run(unparseable_alone), [])

    def test_needs_input_from_a_revise_run_restarts_revise_on_a_trusted_reply(self):
        pr = checks_pull("failed")
        asked = stage_comment(3, "revise", "needs_input")
        self.assertEqual(run(in_flight(pr, asked)), HUMAN_12)
        self.assertEqual(run(in_flight(pr, asked, comment(4, "hi", author="stranger"))), HUMAN_12)
        self.assertEqual(run(in_flight(pr, asked, comment(4, "use the first option"))), start("revise"))

    def test_needs_input_from_a_fix_run_restarts_fix_at_round_one(self):
        asked = stage_comment(3, "fix", "needs_input", round=2)
        self.assertEqual(run(in_flight(checks_pull("failed"), asked, comment(4, "go on"))), start("fix", 1))

    def test_a_failure_from_fix_or_revise_restarts_that_stage_on_retry(self):
        pr = checks_pull("failed")
        for stage, expected in (("fix", start("fix", 1)), ("revise", start("revise"))):
            for outcome in ("failed", "timeout", "crashed"):
                with self.subTest(stage=stage, outcome=outcome):
                    failure = stage_comment(3, stage, outcome, round=2)
                    self.assertEqual(run(in_flight(pr, failure)), HUMAN_12)
                    self.assertEqual(run(in_flight(pr, failure, comment(4, "thanks"))), HUMAN_12)
                    self.assertEqual(run(in_flight(pr, failure, comment(4, "/factory retry"))), expected)

    def test_a_usage_limit_from_revise_restarts_revise_when_its_time_has_come(self):
        pr = checks_pull("failed")
        self.assertEqual(run(in_flight(pr, stage_comment(3, "revise", "usage_limit", retry_at=FUTURE))), QUEUED_12)
        self.assertEqual(run(in_flight(pr, stage_comment(3, "revise", "usage_limit", retry_at=PAST))), start("revise"))


class FixIssueRunsTest(unittest.TestCase):
    """A run of another stage that did not finish keeps today's rows even when its issue has an open pull request."""

    def test_a_failed_fix_issue_run_waits_for_retry_and_a_review_starts_nothing(self):
        pr = checks_pull("failed", reviews=(review("changes_requested"),))
        failed = marker_comment(3, "failed")
        self.assertEqual(run(in_flight(pr, failed)), HUMAN_12)
        self.assertEqual(run(in_flight(pr, failed, comment(4, "/factory retry"))), STARTS_12)

    def test_a_fix_issue_run_that_needs_input_waits_for_a_reply_and_a_review_starts_nothing(self):
        pr = checks_pull("failed", reviews=(review("changes_requested"),))
        asked = marker_comment(3, "needs_input")
        self.assertEqual(run(in_flight(pr, asked)), HUMAN_12)
        self.assertEqual(run(in_flight(pr, asked, comment(4, "go on"))), STARTS_12)


class PullRequestStartRulesTest(unittest.TestCase):
    """A start from the pull request's rows goes through the rules of any other start."""

    def failing(self) -> Issue:
        return in_flight(checks_pull("failed"), stage_comment(3, "fix", round=1))

    def test_pause_queues_instead_of_starting(self):
        paused = issue(12, labels=("factory:fix", "factory:pause"), comments=(stage_comment(3, "fix", round=1),),
                       pull=checks_pull("failed"))
        self.assertEqual(run(paused), QUEUED_12)

    def test_halt_queues_instead_of_starting(self):
        self.assertEqual(run(self.failing(), halted=True), QUEUED_12)

    def test_a_live_job_of_another_issue_queues_it(self):
        actions = run(self.failing(), issue(13), jobs=[JobView("j", 13, "running")])
        self.assertEqual(actions, [*QUEUED_12, SetStatus(13, BUILDING, ())])

    def test_a_usage_limit_ahead_elsewhere_queues_it(self):
        waiting = with_marker(13, "usage_limit", retry_at=FUTURE)
        self.assertEqual(run(self.failing(), waiting)[:1], QUEUED_12)

    def test_an_app_must_be_chosen(self):
        actions = run(self.failing(), apps=("alpha", "beta"))
        self.assertEqual(actions, [PostNotice(12, "needs-app"), SetStatus(12, NEEDS_HUMAN, ())])

    def test_a_job_and_a_settling_job_come_first(self):
        self.assertEqual(run(self.failing(), jobs=[JobView("j", 12, "finished")]), [PublishRun("j", 12)])
        self.assertEqual(run(self.failing(), jobs=[JobView("j", 12, "closed")]), [])

    def test_a_pull_request_that_is_not_open_gets_none_of_the_rows(self):
        closed = dataclasses.replace(checks_pull("failed"), open=False)
        self.assertEqual(run(in_flight(closed, stage_comment(3, "fix", round=1))),
                         [PostNotice(12, "pr-closed"), SetStatus(12, NEEDS_HUMAN, ())])


class AnswersTest(unittest.TestCase):
    """What a revise run is given: the reviews and the instruction nobody has answered with a finished run."""

    def reviews(self, pull_request: PullRequest | None, *comments: Comment) -> tuple[Review, ...]:
        return reviews_to_answer(issue(12, comments=comments, pull=pull_request), CONFIG, BOT)

    def test_none_one_or_two_reviews_oldest_first(self):
        older = review("commented", at="2026-01-01T10:10:00Z", id=1)
        newer = review("changes_requested", at="2026-01-01T10:20:00Z", id=2)
        self.assertEqual(self.reviews(checks_pull("failed")), ())
        self.assertEqual(self.reviews(checks_pull("failed", reviews=(older,))), (older,))
        self.assertEqual(self.reviews(checks_pull("failed", reviews=(newer, older))), (older, newer))

    def test_a_done_revise_run_answers_the_older_reviews(self):
        older = review("commented", at="2026-01-01T10:10:00Z", id=1)
        newer = review("changes_requested", at="2026-01-01T10:40:00Z", id=2)
        pr = checks_pull("failed", reviews=(older, newer))
        self.assertEqual(self.reviews(pr, stage_comment(3, "revise", job_at=LATE_JOB)), (newer,))

    def test_a_failed_revise_run_leaves_its_reviews_for_the_retry(self):
        older = review("commented", at="2026-01-01T10:10:00Z", id=1)
        pr = checks_pull("failed", reviews=(older,))
        self.assertEqual(self.reviews(pr, stage_comment(3, "revise", "failed", job_at=LATE_JOB)), (older,))
        done_then_failed = (stage_comment(3, "revise", job_at=EARLY_JOB), stage_comment(4, "revise", "failed", job_at=LATE_JOB))
        self.assertEqual(self.reviews(pr, *done_then_failed), (older,))

    def test_reviews_that_do_not_ask_or_are_not_trusted_are_left_out(self):
        left_out = (review("approved"), review("changes_requested", author="stranger"), review("dismissed"),
                    review("commented", at="not a time"))
        self.assertEqual(self.reviews(checks_pull("failed", reviews=left_out)), ())

    def test_no_open_pull_request_means_no_reviews(self):
        closed = dataclasses.replace(checks_pull("failed", reviews=(review("commented"),)), open=False)
        self.assertEqual(self.reviews(closed), ())
        self.assertEqual(self.reviews(None), ())

    def instruction(self, *comments: Comment) -> str:
        return revise_instruction(issue(12, comments=comments, pull=checks_pull("failed")), CONFIG, BOT)

    def test_the_instruction_is_the_newest_trusted_command_after_the_last_done_revise_run(self):
        self.assertEqual(self.instruction(), "")
        self.assertEqual(self.instruction(comment(2, "/factory revise rename it")), "rename it")
        self.assertEqual(self.instruction(comment(2, "/factory revise first"), comment(3, "/factory revise second")),
                         "second")
        self.assertEqual(self.instruction(comment(2, "/factory revise first"), comment(3, "/factory revise")), "")

    def test_the_instruction_ignores_strangers_the_bot_and_answered_commands(self):
        self.assertEqual(self.instruction(comment(2, "/factory revise no", author="stranger")), "")
        bot_said = Comment(2, BOT.login, BOT.user_id, "2026-01-01T10:00:00Z", "/factory revise no")
        self.assertEqual(self.instruction(bot_said), "")
        self.assertEqual(self.instruction(comment(2, "/factory revise old"), stage_comment(3, "revise", job_at=LATE_JOB)), "")
        failed = stage_comment(3, "revise", "failed", job_at=LATE_JOB)
        self.assertEqual(self.instruction(comment(2, "/factory revise old"), failed), "old")


class MarkerShapeTest(unittest.TestCase):
    """A run marker is the one with `"kind": "run"`; any other shape is an unknown kind."""

    def test_the_same_stream_reads_differently_without_the_kind(self):
        failed = checks_pull("failed")
        real = stage_comment(3, "fix", round=1)
        kindless = odd_marker_comment(3, {"job": f"{JOB_AT}-fix-12-0a1b2c3d", "stage": "fix", "outcome": "done", "round": 1})
        self.assertEqual(run(building_issue(failed, real)), [StartJob(12, "demo", "fix", 2)])
        self.assertEqual(run(building_issue(failed, kindless)), [])

    def test_a_kindless_marker_is_not_a_failed_run_that_waits_for_a_retry(self):
        kindless = odd_marker_comment(3, {"stage": "fix", "outcome": "failed", "round": 1})
        retried = in_flight(checks_pull("failed"), kindless, comment(4, "/factory retry"))
        self.assertEqual(run(retried), STARTS_12)  # today's row for a failure, not the table's `fix` restart

    def test_a_failed_fix_issue_run_keeps_todays_rows_with_an_open_pull_request(self):
        self.assertEqual(run(in_flight(checks_pull("failed"), marker_comment(3, "failed"))), HUMAN_12)


class OrderOfTheRowsTest(unittest.TestCase):
    def test_the_answer_to_a_question_wins_over_a_review(self):
        pr = checks_pull("failed", reviews=(review("changes_requested"),))
        asked = stage_comment(3, "fix", "needs_input", round=2)
        self.assertEqual(run(in_flight(pr, asked, comment(4, "go on"))), start("fix", 1))

    def test_a_retry_and_a_new_review_start_one_revise(self):
        pr = checks_pull("failed", reviews=(review("changes_requested"),))
        failed = stage_comment(3, "revise", "failed", job_at=EARLY_JOB)
        self.assertEqual(run(in_flight(pr, failed, comment(4, "/factory retry"))), start("revise"))
        self.assertEqual(run(in_flight(pr, failed)), start("revise"))

    def test_a_notice_of_another_kind_keeps_todays_rows_even_with_a_review(self):
        pr = checks_pull("failed", reviews=(review("changes_requested"),))
        self.assertEqual(run(in_flight(pr, notice_comment(3, "pr-closed"))), HUMAN_12)
        self.assertEqual(run(in_flight(pr, notice_comment(3, "untrusted-author"))), HUMAN_12)


class NeedsAppBehindTwoNoticesTest(unittest.TestCase):
    def test_an_invalid_app_asks_again_and_a_valid_one_is_found_behind_both_notices(self):
        apps = ("alpha", "beta")
        failed = checks_pull("failed")
        done = stage_comment(3, "fix", round=1)
        first, wrong = notice_comment(4, "needs-app"), comment(5, "app: gamma")
        second = notice_comment(6, "needs-app")
        self.assertEqual(run(in_flight(failed, done, first, wrong), apps=apps),
                         [PostNotice(12, "needs-app"), SetStatus(12, NEEDS_HUMAN, ())])
        self.assertEqual(run(in_flight(failed, done, first, wrong, second), apps=apps), HUMAN_12)
        right = comment(7, "app: beta")
        self.assertEqual(run(in_flight(failed, done, first, wrong, second, right), apps=apps),
                         [SetStatus(12, BUILDING, ()), StartJob(12, "beta", "fix", 2)])


class ClosedAfterTheHandOffTest(unittest.TestCase):
    def test_a_pull_request_closed_after_the_hand_off_gets_the_notice_once(self):
        closed = dataclasses.replace(checks_pull("passed"), open=False)
        self.assertEqual(run(in_flight(closed, handoff_comment(3))),
                         [PostNotice(12, "pr-closed"), SetStatus(12, NEEDS_HUMAN, ())])
        after = in_flight(closed, handoff_comment(3), notice_comment(4, "pr-closed"))
        self.assertEqual(run(after), HUMAN_12)

    def test_with_the_pull_request_open_the_status_is_building(self):
        self.assertEqual(run(in_flight(checks_pull("passed"), handoff_comment(3))), [SetStatus(12, BUILDING, ())])


class PullRequestDescribeTest(unittest.TestCase):
    def test_start_job_names_the_stage_and_a_round_above_zero(self):
        self.assertEqual(StartJob(12, "demo", "fix", 2).describe(), "issue #12: start a fix run (round 2) for app demo")
        self.assertEqual(StartJob(12, "demo", "revise").describe(), "issue #12: start a revise run for app demo")

    def test_hand_off_describes_itself(self):
        self.assertEqual(HandOff(12).describe(), "issue #12: hand the pull request over for review")


class DescribeTest(unittest.TestCase):
    def test_decide_is_deterministic(self):
        issues = (issue(13), issue(12, comments=(marker_comment(3, "failed"),)), issue(14, open=False, labels=("factory:fix", BUILDING)))
        self.assertEqual(run(*issues), run(*issues))

    def test_describe_is_one_plain_line_without_issue_text(self):
        actions = [
            SetStatus(12, BUILDING, (QUEUED,)), SetStatus(12, None, (QUEUED,)), StartJob(12, "demo"),
            PublishRun("j", 12), PostNotice(12, "needs-app"), CloseJob("j", CLOSE_REASON),
        ]
        for action in actions:
            self.assertNotIn("\n", action.describe())
        self.assertEqual(StartJob(12, "demo").describe(), "issue #12: start a fix_issue run for app demo")
        self.assertIn("status:building", SetStatus(12, BUILDING, (QUEUED,)).describe())
        self.assertIn("#12", PostNotice(12, "needs-app").describe())
        self.assertIn("needs-app", PostNotice(12, "needs-app").describe())


if __name__ == "__main__":
    unittest.main()

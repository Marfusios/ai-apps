"""Tests for the decision function: one test per row of the situation table and per rule."""

import dataclasses
import unittest
from datetime import datetime, timezone

from factory import config as factory_config
from factory import markers
from factory.decide import CloseJob, HandOff, JobView, PostNotice, PublishRun, SetStatus, StartJob, decide
from factory.snapshot import Bot, Check, Comment, Issue, PullRequest, Review, Snapshot

CONFIG = factory_config.load()
BOT = Bot("mk-factory[bot]", 4242)
NOW = datetime(2026, 1, 1, 12, 0, 0, tzinfo=timezone.utc)
FUTURE = "2026-01-01T13:00:00Z"
PAST = "2026-01-01T11:00:00Z"
BUILDING, QUEUED, NEEDS_HUMAN, DONE = "status:building", "status:queued", "status:needs-human", "status:done"
CLOSE_REASON = "the issue is closed or no longer labelled"


def comment(id: int, body: str = "hello", author: str = "Marfusios") -> Comment:
    return Comment(id, author, 1, "2026-01-01T10:00:00Z", body)


def marker_comment(id: int, outcome: str, **data) -> Comment:
    body = "Something happened.\n\n" + markers.encode({"outcome": outcome, **data})
    return Comment(id, BOT.login, BOT.user_id, "2026-01-01T10:00:00Z", body)


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

    CLOSED = JobView("j1", 12, "closed")

    def test_a_closed_job_whose_marker_is_not_visible_yet_means_no_actions(self):
        lagging = issue(12, comments=(marker_comment(3, "needs_input"), comment(4)))
        self.assertEqual(run(lagging, jobs=[self.CLOSED]), [])

    def test_once_its_marker_is_visible_the_table_applies_again(self):
        seen = issue(
            12, comments=(marker_comment(3, "needs_input"), comment(4), marker_comment(5, "needs_input", job="j1"))
        )
        self.assertEqual(run(seen, jobs=[self.CLOSED]), HUMAN_12)

    def test_a_marker_of_another_job_does_not_end_the_settling(self):
        other = issue(12, comments=(marker_comment(3, "needs_input", job="j0"), comment(4)))
        self.assertEqual(run(other, jobs=[self.CLOSED]), [])

    def test_a_marker_whose_job_is_not_a_string_counts_as_no_job_and_raises_nothing(self):
        for job in (["j1"], {"a": 1}, 5, None):
            with self.subTest(job=job):
                history = issue(12, comments=(marker_comment(3, "needs_input", job=job),))
                self.assertEqual(run(history), HUMAN_12)
                self.assertEqual(run(history, jobs=[self.CLOSED]), [])

    def test_a_fresh_issue_with_a_closed_job_does_not_start(self):
        self.assertEqual(run(issue(12), jobs=[self.CLOSED]), [])

    def test_a_settling_issue_blocks_every_start_for_this_poll(self):
        lagging = issue(12, comments=(marker_comment(3, "needs_input"),))
        self.assertEqual(run(lagging, issue(13), jobs=[self.CLOSED]), [SetStatus(13, QUEUED, ())])

    def test_once_its_marker_is_visible_a_closed_job_blocks_nothing(self):
        seen = issue(12, comments=(marker_comment(3, "usage_limit", job="j1", retry_at=PAST),))
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
                self.assertEqual(run(with_marker(12, "usage_limit", retry_at=retry_at)), STARTS_12)
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
        self.assertEqual(run(with_marker(12, "mystery")), [])
        self.assertEqual(run(with_marker(12, "published")), [])
        bare = Comment(3, BOT.login, BOT.user_id, "2026-01-01T10:00:00Z", markers.encode({"job": "x"}))
        self.assertEqual(run(issue(12, comments=(bare,))), [])
        self.assertEqual(run(with_marker(12, ["failed"])), [])

    def test_a_marker_in_a_strangers_comment_changes_nothing(self):
        faked = Comment(3, "stranger", 9, "2026-01-01T10:00:00Z", markers.encode({"outcome": "failed"}))
        self.assertEqual(run(issue(12, comments=(faked,))), STARTS_12)
        lookalike = Comment(3, BOT.login, 1, "2026-01-01T10:00:00Z", markers.encode({"outcome": "failed"}))
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


HEAD = "0123456789abcdef0123456789abcdef01234567"
AFTER = "2026-01-01T10:30:00Z"  # later than the comments of these tests, which carry 10:00:00
BEFORE = "2026-01-01T09:00:00Z"


def checks_pull(state: str, *, draft: bool = False, reviews: tuple[Review, ...] = ()) -> PullRequest:
    """An open pull request whose required checks all read `state` ("passed", "failed" or "pending")."""
    checks = tuple(Check(name, state, index) for index, name in enumerate(CONFIG.dispatcher.required_checks))
    return PullRequest(5, True, False, "https://github.com/owner/repo/pull/5", draft, HEAD, "node", checks, True,
                       "", "", reviews)


def review(state: str, *, author: str = "Marfusios", at: str = AFTER) -> Review:
    return Review(1, author, state, at, "Please change this.")


def stage_comment(id: int, stage: str, outcome: str = "done", **data) -> Comment:
    return marker_comment(id, outcome, stage=stage, **data)


def in_flight(pr: PullRequest, *comments: Comment) -> Issue:
    return issue(12, comments=comments, pull=pr)


def building_issue(pr: PullRequest, *comments: Comment) -> Issue:
    """The issue as the table leaves it while its pull request is in flight: status building already."""
    return issue(12, labels=("factory:fix", BUILDING), comments=comments, pull=pr)


def start(stage: str, round: int = 0) -> list:
    return [SetStatus(12, BUILDING, ()), StartJob(12, "demo", stage, round)]


class FixRowsTest(unittest.TestCase):
    def test_failed_checks_start_fix_rounds_one_to_three(self):
        failed = checks_pull("failed")
        behind = [(), (stage_comment(3, "fix"),), (stage_comment(3, "fix"), stage_comment(4, "fix"))]
        for index, comments in enumerate(behind):
            with self.subTest(fix_runs_behind=index):
                self.assertEqual(run(in_flight(failed, marker_comment(2, "done"), *comments)), start("fix", index + 1))

    def test_failed_checks_with_three_fix_runs_behind_post_the_notice(self):
        fixes = (stage_comment(3, "fix"), stage_comment(4, "fix"), stage_comment(5, "fix"))
        actions = run(in_flight(checks_pull("failed"), *fixes))
        self.assertEqual(actions, [PostNotice(12, "fix-rounds-exhausted"), SetStatus(12, NEEDS_HUMAN, ())])

    def test_once_the_notice_is_in_the_stream_nothing_more_happens(self):
        notice = marker_comment(6, "failed", kind="notice", key="fix-rounds-exhausted")
        fixes = (stage_comment(3, "fix"), stage_comment(4, "fix"), stage_comment(5, "fix"), notice)
        self.assertEqual(run(in_flight(checks_pull("failed"), *fixes)), HUMAN_12)
        waiting = issue(12, labels=("factory:fix", NEEDS_HUMAN), comments=fixes, pull=checks_pull("failed"))
        self.assertEqual(run(waiting), [])

    def test_a_retry_after_the_notice_starts_fix_at_round_one(self):
        notice = marker_comment(6, "failed", kind="notice", key="fix-rounds-exhausted")
        fixes = (stage_comment(3, "fix"), stage_comment(4, "fix"), stage_comment(5, "fix"), notice)
        self.assertEqual(run(in_flight(checks_pull("failed"), *fixes, comment(7, "/factory retry"))), start("fix", 1))

    def test_a_revise_marker_between_fix_markers_restarts_the_count(self):
        history = (stage_comment(3, "fix"), stage_comment(4, "fix"), stage_comment(5, "revise"), stage_comment(6, "fix"))
        self.assertEqual(run(in_flight(checks_pull("failed"), *history)), start("fix", 2))
        ended_by_revise = (stage_comment(3, "fix"), stage_comment(4, "fix"), stage_comment(5, "fix"),
                           stage_comment(6, "revise"))
        self.assertEqual(run(in_flight(checks_pull("failed"), *ended_by_revise)), start("fix", 1))

    def test_a_usage_limit_between_fix_runs_does_not_end_the_count(self):
        history = (stage_comment(3, "fix"), stage_comment(4, "fix", "usage_limit", retry_at=PAST), stage_comment(5, "fix"))
        self.assertEqual(run(in_flight(checks_pull("failed"), *history)), start("fix", 3))

    def test_a_marker_without_a_stage_ends_the_count(self):
        history = (stage_comment(3, "fix"), marker_comment(4, "done"))
        self.assertEqual(run(in_flight(checks_pull("failed"), *history)), start("fix", 1))

    def test_pending_checks_do_nothing(self):
        self.assertEqual(run(in_flight(checks_pull("pending"), marker_comment(3, "done"))), [SetStatus(12, BUILDING, ())])
        self.assertEqual(run(building_issue(checks_pull("pending"), stage_comment(3, "fix"))), [])

    def test_checks_of_an_older_head_are_pending_so_nothing_happens(self):
        stale = dataclasses.replace(checks_pull("failed"), head_sha="abc", checks=())
        self.assertEqual(run(building_issue(stale, stage_comment(3, "fix"))), [])


class HandOffTest(unittest.TestCase):
    def test_passed_checks_on_a_draft_hand_the_pull_request_over(self):
        draft = checks_pull("passed", draft=True)
        self.assertEqual(run(building_issue(draft, marker_comment(3, "done"))), [HandOff(12)])
        self.assertEqual(run(building_issue(draft, stage_comment(3, "revise"))), [HandOff(12)])

    def test_passed_checks_on_a_ready_pull_request_do_nothing(self):
        self.assertEqual(run(building_issue(checks_pull("passed"), stage_comment(3, "fix"))), [])

    def test_a_job_in_flight_holds_the_hand_off_back(self):
        draft = in_flight(checks_pull("passed", draft=True), marker_comment(3, "done"))
        self.assertEqual(run(draft, jobs=[JobView("j", 12, "running")]), [SetStatus(12, BUILDING, ())])


class ReviseRowsTest(unittest.TestCase):
    def test_a_trusted_review_that_changes_or_comments_starts_revise_even_when_checks_failed(self):
        for state in ("changes_requested", "commented"):
            with self.subTest(state=state):
                pr = checks_pull("failed", reviews=(review(state),))
                self.assertEqual(run(in_flight(pr, stage_comment(3, "fix"))), start("revise"))

    def test_a_review_that_does_not_count_starts_nothing(self):
        cases = {
            "untrusted": review("changes_requested", author="stranger"),
            "approval": review("approved"),
            "older than the last marker": review("changes_requested", at=BEFORE),
            "dismissed": review("dismissed"),
        }
        for name, one in cases.items():
            with self.subTest(name):
                pr = checks_pull("pending", reviews=(one,))
                self.assertEqual(run(building_issue(pr, marker_comment(3, "done"))), [])

    def test_a_review_starts_revise_after_a_fix_run_that_needs_input_too(self):
        pr = checks_pull("failed", reviews=(review("commented"),))
        self.assertEqual(run(in_flight(pr, stage_comment(3, "fix", "needs_input"))), start("revise"))

    def test_the_revise_command_starts_revise(self):
        pr = checks_pull("pending")
        self.assertEqual(run(in_flight(pr, stage_comment(3, "fix"), comment(4, "/factory revise tidy the names"))),
                         start("revise"))
        self.assertEqual(run(in_flight(pr, stage_comment(3, "fix"), comment(4, "/Factory Revise"))), start("revise"))

    def test_the_revise_command_must_be_trusted_new_and_exact(self):
        pr = checks_pull("pending")
        later_comments = {
            "stranger": comment(4, "/factory revise now", author="stranger"),
            "not the first line": comment(4, "hello\n/factory revise"),
            "another command": comment(4, "/factory revised"),
        }
        for name, later in later_comments.items():
            with self.subTest(name):
                self.assertEqual(run(building_issue(pr, stage_comment(3, "fix"), later)), [])
        before = building_issue(pr, comment(2, "/factory revise"), stage_comment(3, "fix"))
        self.assertEqual(run(before), [])

    def test_needs_input_from_a_revise_run_restarts_revise_on_a_trusted_reply(self):
        pr = checks_pull("failed")
        asked = stage_comment(3, "revise", "needs_input")
        self.assertEqual(run(in_flight(pr, asked)), HUMAN_12)
        self.assertEqual(run(in_flight(pr, asked, comment(4, "hi", author="stranger"))), HUMAN_12)
        self.assertEqual(run(in_flight(pr, asked, comment(4, "use the first option"))), start("revise"))

    def test_needs_input_from_a_fix_run_restarts_fix(self):
        asked = stage_comment(3, "fix", "needs_input")
        self.assertEqual(run(in_flight(checks_pull("failed"), asked, comment(4, "go on"))), start("fix", 2))

    def test_a_failure_from_fix_or_revise_restarts_that_stage_on_retry(self):
        pr = checks_pull("failed")
        for stage, expected in (("fix", start("fix", 2)), ("revise", start("revise"))):
            for outcome in ("failed", "timeout", "crashed"):
                with self.subTest(stage=stage, outcome=outcome):
                    failure = stage_comment(3, stage, outcome)
                    self.assertEqual(run(in_flight(pr, failure)), HUMAN_12)
                    self.assertEqual(run(in_flight(pr, failure, comment(4, "thanks"))), HUMAN_12)
                    self.assertEqual(run(in_flight(pr, failure, comment(4, "/factory retry"))), expected)

    def test_a_usage_limit_from_fix_or_revise_restarts_that_stage_when_its_time_has_come(self):
        pr = checks_pull("failed")
        for stage, expected in (("fix", start("fix", 1)), ("revise", start("revise"))):
            with self.subTest(stage=stage):
                self.assertEqual(run(in_flight(pr, stage_comment(3, stage, "usage_limit", retry_at=FUTURE))), QUEUED_12)
                self.assertEqual(run(in_flight(pr, stage_comment(3, stage, "usage_limit", retry_at=PAST))), expected)


class PullRequestStartRulesTest(unittest.TestCase):
    """A start from the pull request's rows goes through the rules of any other start."""

    def failing(self) -> Issue:
        return in_flight(checks_pull("failed"), stage_comment(3, "fix"))

    def test_pause_queues_instead_of_starting(self):
        paused = issue(12, labels=("factory:fix", "factory:pause"), comments=(stage_comment(3, "fix"),),
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
        self.assertEqual(run(in_flight(closed, stage_comment(3, "fix"))),
                         [PostNotice(12, "pr-closed"), SetStatus(12, NEEDS_HUMAN, ())])


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

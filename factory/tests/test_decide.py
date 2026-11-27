"""Tests for the decision function: one test per row of the situation table and per rule."""

import unittest
from datetime import datetime, timezone

from factory import config as factory_config
from factory import markers
from factory.decide import CloseJob, JobView, PostNotice, PublishRun, SetStatus, StartJob, decide
from factory.snapshot import Bot, Comment, Issue, PullRequest, Snapshot

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

    def test_no_marker_with_a_pull_request_does_nothing(self):
        self.assertEqual(run(issue(12, pull=pull(open=True))), [])
        self.assertEqual(run(issue(12, pull=pull())), [])

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

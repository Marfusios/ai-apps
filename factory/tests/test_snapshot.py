"""Tests for the snapshot of GitHub state."""

import unittest

from factory import config as factory_config
from factory import markers, snapshot
from factory.github_api import GitHubError, RateLimited
from factory.snapshot import Bot
from factory.tests.fakes import FakeGitHub

CONFIG = factory_config.load()
BOT = Bot("mk-factory[bot]", 4242)
OPEN_LIST = {"state": "open", "labels": "factory:fix", "per_page": "100"}
CLOSED_LIST = {
    "state": "closed", "labels": "factory:fix", "sort": "updated", "direction": "desc", "per_page": "30",
}
HALT_LIST = {"state": "open", "labels": "factory:halt", "per_page": "1"}


def key(path: str, params: dict | None = None) -> tuple:
    return (path, tuple(sorted((params or {}).items())))


def issue_json(number: object, *, state: str = "open", labels: tuple = ("factory:fix",), **extra) -> dict:
    entry = {
        "number": number, "title": f"Issue {number}", "body": "text", "user": {"login": "Marfusios"},
        "state": state, "labels": [{"name": name} for name in labels],
    }
    entry.update(extra)
    return entry


def comment_json(comment_id: int, login: str, user_id: int, body: str = "hello") -> dict:
    return {
        "id": comment_id, "user": {"login": login, "id": user_id}, "created_at": f"2026-01-0{comment_id % 9}T00:00:00Z",
        "body": body,
    }


def labeled(actor: str | None, name: str = "factory:fix") -> dict:
    return {"event": "labeled", "actor": {"login": actor} if actor else None, "label": {"name": name}}


HEAD = "a" * 40


def pull_json(number: int, *, state: str = "open", merged_at: str | None = None, head: object = HEAD, **extra) -> dict:
    entry = {
        "number": number, "state": state, "merged_at": merged_at, "html_url": f"https://example.test/pull/{number}",
        "draft": False, "node_id": f"PR_{number}", "head": {"sha": head, "ref": "factory/fix-12"},
    }
    entry.update(extra)
    return entry


def github_with(open_issues: list, closed_issues: list | None = None) -> FakeGitHub:
    """A fake with empty halt list and apps, and a quiet history for each open issue number."""
    github = FakeGitHub()
    repo = github.repo
    github.answers[key(f"{repo}/issues", OPEN_LIST)] = open_issues
    github.answers[key(f"{repo}/issues", CLOSED_LIST)] = closed_issues or []
    github.answers[key(f"{repo}/issues", HALT_LIST)] = []
    github.answers[key(f"{repo}/contents/apps")] = []
    for entry in [*open_issues, *(closed_issues or [])]:
        if isinstance(entry, dict) and isinstance(entry.get("number"), int):
            add_history(github, entry["number"])
    return github


def add_history(
    github: FakeGitHub, number: int, *, events: list | None = None, comments: list | None = None, pulls: list | None = None
) -> None:
    repo = github.repo
    github.answers[key(f"{repo}/issues/{number}/events", {"per_page": "100"})] = events or []
    github.answers[key(f"{repo}/issues/{number}/comments", {"per_page": "100"})] = comments or []
    head = {"head": f"owner:factory/fix-{number}", "state": "all", "per_page": "10"}
    github.answers[key(f"{repo}/pulls", head)] = pulls or []
    for pull in _objects_of(pulls):
        if pull.get("state") == "open" and isinstance(pull.get("number"), int):
            add_pull_details(github, pull["number"], pull.get("head"))


def _objects_of(items: list | None) -> list[dict]:
    return [item for item in items or [] if isinstance(item, dict)]


def add_pull_details(
    github: FakeGitHub, pull: int, head: object, *, checks: list | None = None, comments: list | None = None,
    reviews: list | None = None,
) -> None:
    """Quiet answers for what `fetch` reads about an open pull request; a valid head also gets check runs."""
    repo = github.repo
    github.answers[key(f"{repo}/issues/{pull}/comments", {"per_page": "100"})] = comments or []
    github.answers[key(f"{repo}/pulls/{pull}/reviews", {"per_page": "100"})] = reviews or []
    sha = head.get("sha") if isinstance(head, dict) else None
    if isinstance(sha, str):
        github.answers[key(f"{repo}/commits/{sha}/check-runs", {"per_page": "100"})] = {
            "total_count": len(checks or []), "check_runs": checks or [],
        }


class FetchTest(unittest.TestCase):
    def test_fetch_builds_issues_with_trigger_comments_and_pull_request(self) -> None:
        github = github_with([issue_json(12, title="Fix it", body="details", labels=("factory:fix", "status:working"))])
        add_history(
            github, 12,
            events=[labeled("Marfusios")],
            comments=[comment_json(7, "someone", 1, "first"), comment_json(8, BOT.login, BOT.user_id, "second")],
            pulls=[pull_json(30, state="closed"), pull_json(31, state="open")],
        )

        result = snapshot.fetch(github, CONFIG)

        self.assertEqual(len(result.issues), 1)
        issue = result.issues[0]
        self.assertEqual((issue.number, issue.title, issue.body, issue.author, issue.open), (12, "Fix it", "details", "Marfusios", True))
        self.assertEqual(issue.labels, ("factory:fix", "status:working"))
        self.assertEqual(issue.trigger_actor, "Marfusios")
        self.assertEqual([(c.id, c.author, c.author_id, c.body) for c in issue.comments],
                         [(7, "someone", 1, "first"), (8, BOT.login, BOT.user_id, "second")])
        self.assertEqual(issue.pull_request, snapshot.PullRequest(31, True, False, "https://example.test/pull/31", False, HEAD, "PR_31"))

    def test_the_last_labeled_event_names_the_trigger_actor(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, events=[
            labeled("outsider"),
            {"event": "unlabeled", "actor": {"login": "outsider"}, "label": {"name": "factory:fix"}},
            labeled("someone-else", "other-label"),
            labeled("Marfusios"),
        ])

        self.assertEqual(snapshot.fetch(github, CONFIG).issues[0].trigger_actor, "Marfusios")

    def test_a_missing_actor_or_no_labeled_event_leaves_no_trigger_actor(self) -> None:
        github = github_with([issue_json(12), issue_json(13)])
        add_history(github, 12, events=[labeled(None)])
        add_history(github, 13, events=[{"event": "closed", "actor": {"login": "x"}}])

        issues = snapshot.fetch(github, CONFIG).issues

        self.assertEqual([i.trigger_actor for i in issues], [None, None])

    def test_comments_are_sorted_by_id_whatever_the_api_order(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, comments=[comment_json(9, "a", 1), comment_json(3, "b", 2), comment_json(5, "c", 3)])

        self.assertEqual([c.id for c in snapshot.fetch(github, CONFIG).issues[0].comments], [3, 5, 9])

    def test_pull_requests_in_the_issue_list_are_dropped(self) -> None:
        github = github_with([issue_json(12), issue_json(13, pull_request={"url": "x"})])

        self.assertEqual([i.number for i in snapshot.fetch(github, CONFIG).issues], [12])

    def test_a_merged_pull_request_is_closed_and_merged(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, pulls=[pull_json(40, state="closed", merged_at="2026-01-01T00:00:00Z")])

        pull = snapshot.fetch(github, CONFIG).issues[0].pull_request

        self.assertEqual((pull.open, pull.merged), (False, True))

    def test_closed_issues_are_kept_only_while_they_carry_an_unfinished_status(self) -> None:
        closed = [
            issue_json(20, state="closed", labels=("factory:fix", "status:failed")),
            issue_json(21, state="closed", labels=("factory:fix", "status:done")),
            issue_json(22, state="closed", labels=("factory:fix",)),
            issue_json(23, state="closed", labels=("factory:fix", "status:done", "status:working")),
            issue_json(24, state="closed", labels=("factory:fix", "status:failed"), pull_request={"url": "x"}),
        ]
        github = github_with([], closed)
        add_history(github, 20, pulls=[pull_json(50, state="closed")])
        for number in (20, 23):  # a request for events or comments of a closed issue now fails the test
            del github.answers[key(f"{github.repo}/issues/{number}/events", {"per_page": "100"})]
            del github.answers[key(f"{github.repo}/issues/{number}/comments", {"per_page": "100"})]

        result = snapshot.fetch(github, CONFIG)

        self.assertEqual([i.number for i in result.issues], [20, 23])
        kept = result.issues[0]
        self.assertEqual((kept.open, kept.trigger_actor, kept.comments), (False, None, ()))
        self.assertEqual(kept.pull_request, snapshot.PullRequest(50, False, False, "https://example.test/pull/50", False, HEAD, "PR_50"))

    def test_halted_and_apps(self) -> None:
        github = github_with([])
        github.answers[key(f"{github.repo}/issues", HALT_LIST)] = [issue_json(1, labels=("factory:halt",))]
        github.answers[key(f"{github.repo}/contents/apps")] = [
            {"name": "zeta", "type": "dir"}, {"name": "README.md", "type": "file"}, {"name": "alpha", "type": "dir"},
        ]

        result = snapshot.fetch(github, CONFIG)

        self.assertTrue(result.halted)
        self.assertEqual(result.apps, ("alpha", "zeta"))

    def test_an_answer_that_is_not_a_list_halts(self) -> None:
        github = github_with([])
        github.answers[key(f"{github.repo}/issues", HALT_LIST)] = {"message": "odd"}

        self.assertTrue(snapshot.fetch(github, CONFIG).halted)

    def test_the_same_issue_twice_in_the_open_list_gives_one_issue(self) -> None:
        github = github_with([issue_json(12, title="first"), issue_json(12, title="second")])

        issues = snapshot.fetch(github, CONFIG).issues

        self.assertEqual([(i.number, i.title) for i in issues], [(12, "first")])

    def test_an_issue_in_both_lists_is_one_open_issue_with_its_history(self) -> None:
        github = github_with(
            [issue_json(12, labels=("factory:fix", "status:working"))],
            [issue_json(12, state="closed", labels=("factory:fix", "status:failed"))],
        )
        add_history(github, 12, events=[labeled("Marfusios")], comments=[comment_json(3, "a", 1)])

        issues = snapshot.fetch(github, CONFIG).issues

        self.assertEqual(len(issues), 1)
        self.assertEqual((issues[0].open, issues[0].trigger_actor, len(issues[0].comments)), (True, "Marfusios", 1))

    def test_openness_comes_from_the_list_not_the_state_field(self) -> None:
        entry = issue_json(12)
        del entry["state"]
        closed = issue_json(20, state="open", labels=("factory:fix", "status:failed"))
        github = github_with([entry], [closed])

        issues = snapshot.fetch(github, CONFIG).issues

        self.assertEqual([(i.number, i.open) for i in issues], [(12, True), (20, False)])

    def test_not_halted_when_the_halt_list_is_empty(self) -> None:
        self.assertFalse(snapshot.fetch(github_with([]), CONFIG).halted)

    def test_a_missing_apps_directory_means_no_apps(self) -> None:
        github = github_with([])
        github.answers[key(f"{github.repo}/contents/apps")] = {"message": "Not Found"}

        self.assertEqual(snapshot.fetch(github, CONFIG).apps, ())

    def test_an_open_issue_that_cannot_be_read_is_unreadable_and_the_fetch_goes_on(self) -> None:
        reads = {
            "events": ("issues/12/events", {"per_page": "100"}),
            "comments": ("issues/12/comments", {"per_page": "100"}),
            "pull request": ("pulls", {"head": "owner:factory/fix-12", "state": "all", "per_page": "10"}),
        }
        for name, (path, params) in reads.items():
            with self.subTest(name):
                github = github_with([issue_json(12, labels=("factory:fix", "status:building")), issue_json(13)])
                add_history(github, 12, events=[labeled("Marfusios")], comments=[comment_json(3, "Marfusios", 1)],
                            pulls=[pull_json(30)])
                add_history(github, 13, events=[labeled("Marfusios")])
                github.raises[key(f"{github.repo}/{path}", params)] = GitHubError(0, "answered more than 10000000 bytes")

                unreadable, readable = snapshot.fetch(github, CONFIG).issues

                self.assertEqual((unreadable.number, unreadable.unreadable, unreadable.trigger_actor,
                                  unreadable.comments, unreadable.pull_request), (12, True, None, (), None))
                self.assertEqual((unreadable.labels, unreadable.open), (("factory:fix", "status:building"), True))
                self.assertEqual((readable.number, readable.unreadable, readable.trigger_actor), (13, False, "Marfusios"))

    def test_a_rate_limit_while_reading_one_issue_still_ends_the_fetch(self) -> None:
        github = github_with([issue_json(12)])
        github.raises[key(f"{github.repo}/issues/12/comments", {"per_page": "100"})] = RateLimited(429, "limit", 0.0)

        with self.assertRaises(RateLimited):
            snapshot.fetch(github, CONFIG)

    def test_a_failing_list_request_ends_the_fetch(self) -> None:
        for listing in (OPEN_LIST, CLOSED_LIST, HALT_LIST, None):
            with self.subTest(listing=listing):
                github = github_with([issue_json(12)])
                path = f"{github.repo}/contents/apps" if listing is None else f"{github.repo}/issues"
                github.raises[key(path, listing)] = GitHubError(502, "down")

                with self.assertRaises(GitHubError):
                    snapshot.fetch(github, CONFIG)

    def test_odd_json_does_not_crash(self) -> None:
        odd = {"number": 12, "title": None, "body": None, "user": None, "state": "open"}  # no labels at all
        github = github_with([odd, "a string", None, issue_json(0), issue_json(-3), issue_json("7"), issue_json(True)])
        add_history(
            github, 12,
            events=["x", {"event": "labeled", "label": None}, None],
            comments=[{"id": 4, "user": None, "body": None}, "text", 5],
            pulls=["x", {"number": "y"}],
        )

        result = snapshot.fetch(github, CONFIG)

        self.assertEqual([i.number for i in result.issues], [12])
        issue = result.issues[0]
        self.assertEqual((issue.title, issue.body, issue.author, issue.labels, issue.trigger_actor), ("", "", "", (), None))
        self.assertEqual([(c.id, c.author, c.author_id, c.body) for c in issue.comments], [(4, "", 0, "")])
        self.assertIsNone(issue.pull_request)


REVIEW_BOT = Bot(CONFIG.review.bot_login, CONFIG.review.bot_user_id)


def run_json(run_id: int, name: object, status: object, conclusion: object) -> dict:
    return {"id": run_id, "name": name, "status": status, "conclusion": conclusion}


def review_comment(comment_id: int, head: str, verdict: str, text: str = "Looks fine.", *, bot: Bot = REVIEW_BOT) -> dict:
    body = f"{text}\n\n{markers.encode_review({'head': head, 'verdict': verdict})}"
    return comment_json(comment_id, bot.login, bot.user_id, body)


def review_json(review_id: int, state: str = "APPROVED", *, submitted_at: str | None = "2026-01-02T00:00:00Z", **extra) -> dict:
    entry = {
        "id": review_id, "user": {"login": "Marfusios", "id": 5}, "state": state, "body": "ok", "submitted_at": submitted_at,
    }
    entry.update(extra)
    return entry


def open_pull(github: FakeGitHub, *, checks=None, comments=None, reviews=None, issue_comments=None, **pull_extra):
    """Fetch issue 12 with an open pull request 31 and return the issue."""
    pull = pull_json(31, **pull_extra)
    add_history(github, 12, pulls=[pull], comments=issue_comments)
    add_pull_details(github, 31, pull["head"], checks=checks, comments=comments, reviews=reviews)
    return snapshot.fetch(github, CONFIG).issues[0]


class PullRequestDetailsTest(unittest.TestCase):
    def test_a_pull_request_carries_its_draft_flag_head_and_node_id(self) -> None:
        issue = open_pull(github_with([issue_json(12)]), draft=True)

        pull = issue.pull_request
        self.assertEqual((pull.draft, pull.head_sha, pull.node_id), (True, HEAD, "PR_31"))

    def test_check_runs_map_to_the_four_states(self) -> None:
        runs = [
            run_json(1, "ok", "completed", "success"), run_json(2, "bad", "completed", "failure"),
            run_json(3, "slow", "completed", "timed_out"), run_json(4, "manual", "completed", "action_required"),
            run_json(5, "cancelled", "completed", "cancelled"), run_json(6, "skipped", "completed", "skipped"),
            run_json(7, "neutral", "completed", "neutral"), run_json(8, "queued", "queued", None),
            run_json(9, "running", "in_progress", None), run_json(10, "odd", "completed", None),
        ]

        pull = open_pull(github_with([issue_json(12)]), checks=runs).pull_request

        self.assertEqual(
            {check.name: check.state for check in pull.checks},
            {"ok": "passed", "bad": "failed", "slow": "failed", "manual": "failed", "cancelled": "other",
             "skipped": "other", "neutral": "other", "queued": "pending", "running": "pending", "odd": "other"},
        )
        self.assertEqual({check.name: check.job_id for check in pull.checks}["bad"], 2)

    def test_of_two_runs_with_one_name_the_highest_id_counts(self) -> None:
        runs = [run_json(9, "check", "completed", "success"), run_json(4, "check", "completed", "failure")]

        pull = open_pull(github_with([issue_json(12)]), checks=runs).pull_request

        self.assertEqual(pull.checks, (snapshot.Check("check", "passed", 9),))

    def test_a_head_that_is_not_a_full_lower_case_sha_gets_no_checks_and_no_verdict(self) -> None:
        for head in ("abc", "A" * 40, "../" + "a" * 37, "a" * 41, None):
            with self.subTest(head=head):
                github = github_with([issue_json(12)])
                issue = open_pull(github, head=head, comments=[review_comment(5, HEAD, "pass")])

                self.assertEqual((issue.pull_request.checks, issue.pull_request.verdict), ((), ""))

    def test_the_verdict_comes_from_the_review_bot_for_this_head(self) -> None:
        pull = open_pull(
            github_with([issue_json(12)]), comments=[review_comment(5, HEAD, "fail", "Problems found.")],
        ).pull_request

        self.assertEqual((pull.verdict, pull.review_text), ("fail", "Problems found."))

    def test_a_review_of_an_older_head_gives_no_verdict(self) -> None:
        pull = open_pull(github_with([issue_json(12)]), comments=[review_comment(5, "b" * 40, "pass")]).pull_request

        self.assertEqual((pull.verdict, pull.review_text), ("", ""))

    def test_a_review_marker_from_another_account_gives_no_verdict(self) -> None:
        impostors = [Bot(REVIEW_BOT.login, REVIEW_BOT.user_id + 1), Bot("someone", REVIEW_BOT.user_id)]
        for impostor in impostors:
            with self.subTest(impostor=impostor):
                comments = [review_comment(5, HEAD, "pass", bot=impostor)]

                pull = open_pull(github_with([issue_json(12)]), comments=comments).pull_request

                self.assertEqual(pull.verdict, "")

    def test_the_newest_review_for_the_head_wins(self) -> None:
        comments = [review_comment(8, HEAD, "pass", "second"), review_comment(3, HEAD, "fail", "first")]

        pull = open_pull(github_with([issue_json(12)]), comments=comments).pull_request

        self.assertEqual((pull.verdict, pull.review_text), ("pass", "second"))

    def test_a_verdict_outside_the_three_known_ones_is_no_verdict(self) -> None:
        pull = open_pull(github_with([issue_json(12)]), comments=[review_comment(5, HEAD, "maybe")]).pull_request

        self.assertEqual(pull.verdict, "")

    def test_a_newer_review_with_an_unknown_verdict_hides_an_older_valid_one(self) -> None:
        comments = [review_comment(3, HEAD, "pass", "older"), review_comment(8, HEAD, "maybe", "newer")]

        pull = open_pull(github_with([issue_json(12)]), comments=comments).pull_request

        self.assertEqual((pull.verdict, pull.review_text), ("", ""))

    def test_every_known_verdict_is_read(self) -> None:
        for verdict in ("pass", "fail", "unavailable"):
            with self.subTest(verdict=verdict):
                pull = open_pull(github_with([issue_json(12)]), comments=[review_comment(5, HEAD, verdict)]).pull_request

                self.assertEqual(pull.verdict, verdict)

    def test_the_review_text_is_cut_before_the_marker_stripped_and_limited(self) -> None:
        comments = [review_comment(5, HEAD, "pass", "  " + "x" * 30000 + "  ")]

        pull = open_pull(github_with([issue_json(12)]), comments=comments).pull_request

        self.assertEqual(pull.review_text, "x" * 20000)

    def test_pull_request_comments_join_the_issue_comments_in_id_order(self) -> None:
        issue = open_pull(
            github_with([issue_json(12)]),
            issue_comments=[comment_json(2, "a", 1), comment_json(6, "b", 2)],
            comments=[comment_json(4, "c", 3), comment_json(7, "d", 4)],
        )

        self.assertEqual([comment.id for comment in issue.comments], [2, 4, 6, 7])

    def test_a_comment_listed_twice_is_kept_once(self) -> None:
        issue = open_pull(
            github_with([issue_json(12)]), issue_comments=[comment_json(4, "a", 1)], comments=[comment_json(4, "a", 1)],
        )

        self.assertEqual([comment.id for comment in issue.comments], [4])

    def test_the_bots_markers_in_pull_request_comments_are_found(self) -> None:
        comments = [comment_json(4, BOT.login, BOT.user_id, markers.encode({"n": 4}))]

        issue = open_pull(github_with([issue_json(12)]), comments=comments)

        self.assertEqual([marker.data["n"] for marker in issue.markers(BOT)], [4])

    def test_reviews_are_parsed_and_a_pending_one_is_dropped(self) -> None:
        reviews = [
            review_json(2, "CHANGES_REQUESTED", body=None), review_json(1, "APPROVED"),
            review_json(3, "COMMENTED", submitted_at=None), review_json(4, "DISMISSED"),
        ]

        pull = open_pull(github_with([issue_json(12)]), reviews=reviews).pull_request

        self.assertEqual(
            pull.reviews,
            (snapshot.Review(2, "Marfusios", "changes_requested", "2026-01-02T00:00:00Z", ""),
             snapshot.Review(1, "Marfusios", "approved", "2026-01-02T00:00:00Z", "ok"),
             snapshot.Review(4, "Marfusios", "dismissed", "2026-01-02T00:00:00Z", "ok")),
        )

    def test_a_closed_or_merged_pull_request_triggers_no_extra_request(self) -> None:
        for pull in (pull_json(31, state="closed"), pull_json(31, state="closed", merged_at="2026-01-01T00:00:00Z")):
            with self.subTest(merged=pull["merged_at"]):
                github = github_with([issue_json(12)])
                add_history(github, 12, pulls=[pull])

                snapshot.fetch(github, CONFIG)  # an unexpected request fails the fake

    def test_a_failing_request_about_the_pull_request_makes_the_issue_unreadable(self) -> None:
        for path in ("issues/31/comments", "pulls/31/reviews", f"commits/{HEAD}/check-runs"):
            with self.subTest(path=path):
                github = github_with([issue_json(12)])
                add_history(github, 12, pulls=[pull_json(31)])
                github.raises[key(f"{github.repo}/{path}", {"per_page": "100"})] = GitHubError(0, "too large")

                issue = snapshot.fetch(github, CONFIG).issues[0]

                self.assertEqual((issue.unreadable, issue.pull_request), (True, None))

    def test_odd_json_about_the_pull_request_does_not_crash(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, pulls=[pull_json(31, draft="yes", node_id=None)])
        github.answers[key(f"{github.repo}/commits/{HEAD}/check-runs", {"per_page": "100"})] = {
            "check_runs": ["x", None, {"id": "1", "name": 3}, run_json(2, "ok", 7, 8)],
        }
        github.answers[key(f"{github.repo}/pulls/31/reviews", {"per_page": "100"})] = ["x", None, {"state": 3}]
        github.answers[key(f"{github.repo}/issues/31/comments", {"per_page": "100"})] = ["x", 5]

        result = snapshot.fetch(github, CONFIG).issues[0].pull_request

        self.assertEqual((result.draft, result.node_id, result.reviews), (False, "", ()))
        self.assertEqual(result.checks, (snapshot.Check("ok", "pending", 2),))

    def test_a_check_runs_answer_that_is_not_an_object_means_no_checks(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, pulls=[pull_json(31)])
        github.answers[key(f"{github.repo}/commits/{HEAD}/check-runs", {"per_page": "100"})] = ["x"]

        self.assertEqual(snapshot.fetch(github, CONFIG).issues[0].pull_request.checks, ())


def pull_with(*checks: snapshot.Check, head_sha: str = HEAD) -> snapshot.PullRequest:
    return snapshot.PullRequest(31, True, False, "u", head_sha=head_sha, checks=checks)


class ChecksStateTest(unittest.TestCase):
    def test_every_required_check_passed_is_passed(self) -> None:
        pull = pull_with(snapshot.Check("a", "passed", 1), snapshot.Check("b", "other", 2))

        self.assertEqual(snapshot.checks_state(pull, ["a"]), "passed")

    def test_a_required_check_not_passed_is_pending(self) -> None:
        for state in ("pending", "other"):
            with self.subTest(state=state):
                pull = pull_with(snapshot.Check("a", state, 1))

                self.assertEqual(snapshot.checks_state(pull, ["a"]), "pending")

    def test_a_required_check_that_is_missing_is_pending(self) -> None:
        pull = pull_with(snapshot.Check("a", "passed", 1))

        self.assertEqual(snapshot.checks_state(pull, ["a", "b"]), "pending")

    def test_a_failed_required_check_fails(self) -> None:
        pull = pull_with(snapshot.Check("a", "failed", 1), snapshot.Check("b", "pending", 2))

        self.assertEqual(snapshot.checks_state(pull, ["a", "b", "missing"]), "failed")

    def test_a_failed_check_that_is_not_required_does_not_decide(self) -> None:
        passed = pull_with(snapshot.Check("a", "passed", 1), snapshot.Check("extra", "failed", 2))
        waiting = pull_with(snapshot.Check("a", "pending", 1), snapshot.Check("extra", "failed", 2))

        self.assertEqual(snapshot.checks_state(passed, ["a"]), "passed")
        self.assertEqual(snapshot.checks_state(waiting, ["a"]), "pending")

    def test_a_pull_request_without_a_head_is_pending(self) -> None:
        self.assertEqual(snapshot.checks_state(pull_with(head_sha=""), []), "pending")

    def test_no_required_checks_and_none_failed_is_passed(self) -> None:
        self.assertEqual(snapshot.checks_state(pull_with(), []), "passed")


class MarkerTest(unittest.TestCase):
    def test_markers_count_only_in_the_bots_own_comments(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, comments=[
            comment_json(1, "Marfusios", 99, markers.encode({"n": 1})),
            comment_json(2, BOT.login, 7, markers.encode({"n": 2})),  # same name, another account
            comment_json(3, BOT.login, BOT.user_id, markers.encode({"n": 3})),
            comment_json(4, BOT.login, BOT.user_id, "no marker here"),
        ])

        issue = snapshot.fetch(github, CONFIG).issues[0]

        self.assertEqual([m.data["n"] for m in issue.markers(BOT)], [3])
        self.assertEqual(issue.markers(BOT)[0].comment_id, 3)

    def test_markers_come_oldest_first(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, comments=[
            comment_json(6, BOT.login, BOT.user_id, markers.encode({"n": 6})),
            comment_json(2, BOT.login, BOT.user_id, markers.encode({"n": 2})),
        ])

        issue = snapshot.fetch(github, CONFIG).issues[0]

        self.assertEqual([m.data["n"] for m in issue.markers(BOT)], [2, 6])

    def test_a_bot_without_a_login_or_id_matches_no_comment(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, comments=[{"id": 1, "user": None, "body": markers.encode({"n": 1})}])

        issue = snapshot.fetch(github, CONFIG).issues[0]

        self.assertEqual(issue.markers(Bot("", 0)), ())

    def test_the_outcome_is_the_marker_text_or_empty(self) -> None:
        text = snapshot.Marker(1, "t", {"outcome": "published"})
        other = snapshot.Marker(1, "t", {"outcome": 3})

        self.assertEqual((text.outcome, other.outcome, snapshot.Marker(1, "t", {}).outcome), ("published", "", ""))


class CommentFromTest(unittest.TestCase):
    def test_a_listed_comment_becomes_a_comment(self) -> None:
        self.assertEqual(snapshot.comment_from(comment_json(7, "someone", 5, "hi")),
                         snapshot.Comment(7, "someone", 5, "2026-01-07T00:00:00Z", "hi"))

    def test_odd_fields_read_as_empty(self) -> None:
        odd = {"id": "4", "user": {"login": 3, "id": True}, "created_at": None, "body": None}
        self.assertEqual(snapshot.comment_from(odd), snapshot.Comment(0, "", 0, "", ""))
        self.assertEqual(snapshot.comment_from({"id": 4, "user": "x"}), snapshot.Comment(4, "", 0, "", ""))

    def test_an_entry_that_is_not_an_object_is_no_comment(self) -> None:
        for entry in ("text", 5, None, [], True):
            with self.subTest(entry=entry):
                self.assertIsNone(snapshot.comment_from(entry))


class SmallRecordsTest(unittest.TestCase):
    def test_the_bot_email_is_its_noreply_address(self) -> None:
        self.assertEqual(BOT.email, "4242+mk-factory[bot]@users.noreply.github.com")

    def test_the_branch_of_an_issue(self) -> None:
        self.assertEqual(snapshot.branch_for(12), "factory/fix-12")


if __name__ == "__main__":
    unittest.main()

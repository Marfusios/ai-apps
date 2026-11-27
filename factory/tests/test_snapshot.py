"""Tests for the snapshot of GitHub state."""

import unittest

from factory import markers, snapshot
from factory.github_api import GitHubError
from factory.snapshot import Bot
from factory.tests.fakes import FakeGitHub

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


def pull_json(number: int, *, state: str = "open", merged_at: str | None = None) -> dict:
    return {"number": number, "state": state, "merged_at": merged_at, "html_url": f"https://example.test/pull/{number}"}


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


class FetchTest(unittest.TestCase):
    def test_fetch_builds_issues_with_trigger_comments_and_pull_request(self) -> None:
        github = github_with([issue_json(12, title="Fix it", body="details", labels=("factory:fix", "status:working"))])
        add_history(
            github, 12,
            events=[labeled("Marfusios")],
            comments=[comment_json(7, "someone", 1, "first"), comment_json(8, BOT.login, BOT.user_id, "second")],
            pulls=[pull_json(30, state="closed"), pull_json(31, state="open")],
        )

        result = snapshot.fetch(github)

        self.assertEqual(len(result.issues), 1)
        issue = result.issues[0]
        self.assertEqual((issue.number, issue.title, issue.body, issue.author, issue.open), (12, "Fix it", "details", "Marfusios", True))
        self.assertEqual(issue.labels, ("factory:fix", "status:working"))
        self.assertEqual(issue.trigger_actor, "Marfusios")
        self.assertEqual([(c.id, c.author, c.author_id, c.body) for c in issue.comments],
                         [(7, "someone", 1, "first"), (8, BOT.login, BOT.user_id, "second")])
        self.assertEqual(issue.pull_request, snapshot.PullRequest(31, True, False, "https://example.test/pull/31"))

    def test_the_last_labeled_event_names_the_trigger_actor(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, events=[
            labeled("outsider"),
            {"event": "unlabeled", "actor": {"login": "outsider"}, "label": {"name": "factory:fix"}},
            labeled("someone-else", "other-label"),
            labeled("Marfusios"),
        ])

        self.assertEqual(snapshot.fetch(github).issues[0].trigger_actor, "Marfusios")

    def test_a_missing_actor_or_no_labeled_event_leaves_no_trigger_actor(self) -> None:
        github = github_with([issue_json(12), issue_json(13)])
        add_history(github, 12, events=[labeled(None)])
        add_history(github, 13, events=[{"event": "closed", "actor": {"login": "x"}}])

        issues = snapshot.fetch(github).issues

        self.assertEqual([i.trigger_actor for i in issues], [None, None])

    def test_comments_are_sorted_by_id_whatever_the_api_order(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, comments=[comment_json(9, "a", 1), comment_json(3, "b", 2), comment_json(5, "c", 3)])

        self.assertEqual([c.id for c in snapshot.fetch(github).issues[0].comments], [3, 5, 9])

    def test_pull_requests_in_the_issue_list_are_dropped(self) -> None:
        github = github_with([issue_json(12), issue_json(13, pull_request={"url": "x"})])

        self.assertEqual([i.number for i in snapshot.fetch(github).issues], [12])

    def test_a_merged_pull_request_is_closed_and_merged(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, pulls=[pull_json(40, state="closed", merged_at="2026-01-01T00:00:00Z")])

        pull = snapshot.fetch(github).issues[0].pull_request

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

        result = snapshot.fetch(github)

        self.assertEqual([i.number for i in result.issues], [20, 23])
        kept = result.issues[0]
        self.assertEqual((kept.open, kept.trigger_actor, kept.comments), (False, None, ()))
        self.assertEqual(kept.pull_request, snapshot.PullRequest(50, False, False, "https://example.test/pull/50"))

    def test_halted_and_apps(self) -> None:
        github = github_with([])
        github.answers[key(f"{github.repo}/issues", HALT_LIST)] = [issue_json(1, labels=("factory:halt",))]
        github.answers[key(f"{github.repo}/contents/apps")] = [
            {"name": "zeta", "type": "dir"}, {"name": "README.md", "type": "file"}, {"name": "alpha", "type": "dir"},
        ]

        result = snapshot.fetch(github)

        self.assertTrue(result.halted)
        self.assertEqual(result.apps, ("alpha", "zeta"))

    def test_an_answer_that_is_not_a_list_halts(self) -> None:
        github = github_with([])
        github.answers[key(f"{github.repo}/issues", HALT_LIST)] = {"message": "odd"}

        self.assertTrue(snapshot.fetch(github).halted)

    def test_the_same_issue_twice_in_the_open_list_gives_one_issue(self) -> None:
        github = github_with([issue_json(12, title="first"), issue_json(12, title="second")])

        issues = snapshot.fetch(github).issues

        self.assertEqual([(i.number, i.title) for i in issues], [(12, "first")])

    def test_an_issue_in_both_lists_is_one_open_issue_with_its_history(self) -> None:
        github = github_with(
            [issue_json(12, labels=("factory:fix", "status:working"))],
            [issue_json(12, state="closed", labels=("factory:fix", "status:failed"))],
        )
        add_history(github, 12, events=[labeled("Marfusios")], comments=[comment_json(3, "a", 1)])

        issues = snapshot.fetch(github).issues

        self.assertEqual(len(issues), 1)
        self.assertEqual((issues[0].open, issues[0].trigger_actor, len(issues[0].comments)), (True, "Marfusios", 1))

    def test_openness_comes_from_the_list_not_the_state_field(self) -> None:
        entry = issue_json(12)
        del entry["state"]
        closed = issue_json(20, state="open", labels=("factory:fix", "status:failed"))
        github = github_with([entry], [closed])

        issues = snapshot.fetch(github).issues

        self.assertEqual([(i.number, i.open) for i in issues], [(12, True), (20, False)])

    def test_not_halted_when_the_halt_list_is_empty(self) -> None:
        self.assertFalse(snapshot.fetch(github_with([])).halted)

    def test_a_missing_apps_directory_means_no_apps(self) -> None:
        github = github_with([])
        github.answers[key(f"{github.repo}/contents/apps")] = {"message": "Not Found"}

        self.assertEqual(snapshot.fetch(github).apps, ())

    def test_a_failing_request_ends_the_fetch(self) -> None:
        github = github_with([issue_json(12)])
        github.fail.add(f"{github.repo}/issues/12/comments")

        with self.assertRaises(GitHubError):
            snapshot.fetch(github)

    def test_a_failing_pull_request_lookup_ends_the_fetch(self) -> None:
        github = github_with([issue_json(12)])
        github.fail.add(f"{github.repo}/pulls")

        with self.assertRaises(GitHubError):
            snapshot.fetch(github)

    def test_odd_json_does_not_crash(self) -> None:
        odd = {"number": 12, "title": None, "body": None, "user": None, "state": "open"}  # no labels at all
        github = github_with([odd, "a string", None, issue_json(0), issue_json(-3), issue_json("7"), issue_json(True)])
        add_history(
            github, 12,
            events=["x", {"event": "labeled", "label": None}, None],
            comments=[{"id": 4, "user": None, "body": None}, "text", 5],
            pulls=["x", {"number": "y"}],
        )

        result = snapshot.fetch(github)

        self.assertEqual([i.number for i in result.issues], [12])
        issue = result.issues[0]
        self.assertEqual((issue.title, issue.body, issue.author, issue.labels, issue.trigger_actor), ("", "", "", (), None))
        self.assertEqual([(c.id, c.author, c.author_id, c.body) for c in issue.comments], [(4, "", 0, "")])
        self.assertIsNone(issue.pull_request)


class MarkerTest(unittest.TestCase):
    def test_markers_count_only_in_the_bots_own_comments(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, comments=[
            comment_json(1, "Marfusios", 99, markers.encode({"n": 1})),
            comment_json(2, BOT.login, 7, markers.encode({"n": 2})),  # same name, another account
            comment_json(3, BOT.login, BOT.user_id, markers.encode({"n": 3})),
            comment_json(4, BOT.login, BOT.user_id, "no marker here"),
        ])

        issue = snapshot.fetch(github).issues[0]

        self.assertEqual([m.data["n"] for m in issue.markers(BOT)], [3])
        self.assertEqual(issue.markers(BOT)[0].comment_id, 3)

    def test_markers_come_oldest_first(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, comments=[
            comment_json(6, BOT.login, BOT.user_id, markers.encode({"n": 6})),
            comment_json(2, BOT.login, BOT.user_id, markers.encode({"n": 2})),
        ])

        issue = snapshot.fetch(github).issues[0]

        self.assertEqual([m.data["n"] for m in issue.markers(BOT)], [2, 6])

    def test_a_bot_without_a_login_or_id_matches_no_comment(self) -> None:
        github = github_with([issue_json(12)])
        add_history(github, 12, comments=[{"id": 1, "user": None, "body": markers.encode({"n": 1})}])

        issue = snapshot.fetch(github).issues[0]

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

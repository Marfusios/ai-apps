"""One poll of GitHub turned into the frozen records the dispatcher's decision function reads."""

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace

from factory import markers
from factory.config import Config
from factory.github_api import GitHub, GitHubError, RateLimited

FIX_LABEL = "factory:fix"
HALT_LABEL = "factory:halt"
DONE_STATUS = "status:done"
CLOSED_ISSUES_SEEN = 30
REVIEW_TEXT_LIMIT = 20_000
VERDICTS = frozenset({"pass", "fail", "unavailable"})
_SHA = re.compile(r"[0-9a-f]{40}")
_FAILED_CONCLUSIONS = frozenset({"failure", "timed_out", "action_required"})


@dataclass(frozen=True)
class Bot:
    login: str
    user_id: int

    @property
    def email(self) -> str:
        return f"{self.user_id}+{self.login}@users.noreply.github.com"


@dataclass(frozen=True)
class Comment:
    id: int
    author: str
    author_id: int
    created_at: str
    body: str


@dataclass(frozen=True)
class Marker:
    comment_id: int
    created_at: str
    data: Mapping[str, object]

    @property
    def outcome(self) -> str:
        outcome = self.data.get("outcome")
        return outcome if isinstance(outcome, str) else ""


@dataclass(frozen=True)
class Check:
    name: str
    state: str  # "pending", "passed", "failed", or "other" for cancelled, skipped and neutral
    job_id: int


@dataclass(frozen=True)
class Review:
    id: int
    author: str
    state: str  # lower case: approved, changes_requested, commented or dismissed
    submitted_at: str
    body: str


@dataclass(frozen=True)
class PullRequest:
    number: int
    open: bool
    merged: bool
    url: str
    draft: bool = False
    head_sha: str = ""
    node_id: str = ""
    # what is known only of an open pull request whose head is a full commit id
    checks: tuple[Check, ...] = ()
    verdict: str = ""  # the second-model review's verdict for this head, or empty
    review_text: str = ""
    reviews: tuple[Review, ...] = ()


@dataclass(frozen=True)
class Issue:
    number: int
    title: str
    body: str
    author: str
    open: bool
    labels: tuple[str, ...]
    trigger_actor: str | None
    comments: tuple[Comment, ...]
    pull_request: PullRequest | None
    # GitHub would not give this open issue's events, comments or pull request in this poll, so it has none of them
    unreadable: bool = False

    def markers(self, bot: Bot) -> tuple[Marker, ...]:
        """Markers in the bot's own comments, oldest first.

        The login alone is not enough: the numeric id is what GitHub guarantees to be unique, so a
        comment by another account that shows the bot's name does not count.
        """
        found = []
        for comment in self.comments:
            if comment.author != bot.login or comment.author_id != bot.user_id:
                continue
            if not bot.login or bot.user_id <= 0:
                continue  # a missing user reads as ("", 0) and must never match a bot
            data = markers.parse(comment.body)
            if data is not None:
                found.append(Marker(comment.id, comment.created_at, data))
        return tuple(found)


@dataclass(frozen=True)
class Snapshot:
    issues: tuple[Issue, ...]
    halted: bool
    apps: tuple[str, ...]


def branch_for(issue_number: int) -> str:
    return f"factory/fix-{issue_number}"


def _objects(items: object) -> list[dict]:
    return [item for item in items if isinstance(item, dict)] if isinstance(items, list) else []


def _text(value: object) -> str:
    return value if isinstance(value, str) else ""


def _integer(value: object) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else 0


def _login(user: object) -> str:
    return _text(user.get("login")) if isinstance(user, dict) else ""


def _labels(raw: dict) -> tuple[str, ...]:
    return tuple(_text(label.get("name")) for label in _objects(raw.get("labels")))


def comment_from(entry: object) -> Comment | None:
    """A comment as GitHub lists it, or None for an entry that is not an object.

    A missing or odd field reads as empty or 0, and a comment without a user then matches no bot.
    """
    if not isinstance(entry, dict):
        return None
    user = entry.get("user")
    author_id = _integer(user.get("id")) if isinstance(user, dict) else 0
    return Comment(_integer(entry.get("id")), _login(user), author_id, _text(entry.get("created_at")),
                   _text(entry.get("body")))


def _trigger_actor(events: list) -> str | None:
    """Who applied the label last: removing and re-applying it makes the later person the trigger."""
    actor = None
    for event in _objects(events):
        label = event.get("label")
        if event.get("event") == "labeled" and isinstance(label, dict) and label.get("name") == FIX_LABEL:
            actor = _login(event.get("actor")) or None
    return actor


def _pull_request(candidates: object) -> PullRequest | None:
    pulls = [pull for pull in _objects(candidates) if _integer(pull.get("number")) > 0]
    if not pulls:
        return None
    latest = max(pulls, key=lambda pull: pull["number"])
    head = latest.get("head")
    return PullRequest(
        latest["number"], latest.get("state") == "open", latest.get("merged_at") is not None,
        _text(latest.get("html_url")), latest.get("draft") is True,
        _text(head.get("sha")) if isinstance(head, dict) else "", _text(latest.get("node_id")),
    )


def checks_state(pull: PullRequest, required: Sequence[str]) -> str:
    """Only required names decide: failed when one failed, else pending until all have passed, else passed.

    A failed check that is not required (a helper job broken for infrastructure reasons) is ignored: the
    required aggregate names cover real failures.
    """
    if not pull.head_sha:
        return "pending"
    states = {check.name: check.state for check in pull.checks}
    if any(states.get(name) == "failed" for name in required):
        return "failed"
    return "pending" if any(states.get(name) != "passed" for name in required) else "passed"


def _check_state(run: dict) -> str:
    if run.get("status") != "completed":
        return "pending"
    conclusion = run.get("conclusion")
    if conclusion == "success":
        return "passed"
    return "failed" if conclusion in _FAILED_CONCLUSIONS else "other"


def _checks(answer: object) -> tuple[Check, ...]:
    """The newest run of each name: a re-run has a higher id and replaces the earlier one."""
    runs = _objects(answer.get("check_runs")) if isinstance(answer, dict) else []
    newest: dict[str, dict] = {}
    for run in runs:
        name = _text(run.get("name"))
        if name and _integer(run.get("id")) >= _integer(newest.get(name, {}).get("id")):
            newest[name] = run
    return tuple(Check(name, _check_state(run), _integer(run.get("id"))) for name, run in newest.items())


def _reviews(raw: list) -> tuple[Review, ...]:
    """The submitted reviews; a pending one has no submission time and is not yet anyone's word."""
    return tuple(
        Review(_integer(entry.get("id")), _login(entry.get("user")), _text(entry.get("state")).lower(),
               _text(entry.get("submitted_at")), _text(entry.get("body")))
        for entry in _objects(raw)
        if _text(entry.get("submitted_at"))
    )


def _verdict(comments: Sequence[Comment], head: str, config: Config) -> tuple[str, str]:
    """The verdict and text of the review bot's newest comment about this head.

    Empty when it has none, or when that newest comment's verdict is not a known one: an older comment
    for the same head is superseded, not a fallback.
    """
    bot = config.review
    for comment in sorted(comments, key=lambda comment: comment.id, reverse=True):
        if comment.author != bot.bot_login or comment.author_id != bot.bot_user_id:
            continue
        data = markers.parse_review(comment.body)
        if data is not None and data.get("head") == head:
            if data.get("verdict") not in VERDICTS:
                return "", ""
            text = comment.body[: comment.body.index(markers.REVIEW_PREFIX)]
            return data["verdict"], text.strip()[:REVIEW_TEXT_LIMIT]
    return "", ""


def _sorted_comments(raw: list) -> tuple[Comment, ...]:
    listed = (comment_from(entry) for entry in raw)
    return tuple(sorted((comment for comment in listed if comment is not None), key=lambda comment: comment.id))


def _merged(first: tuple[Comment, ...], second: tuple[Comment, ...]) -> tuple[Comment, ...]:
    """Both lists in id order; GitHub's ids are unique across them, so a repeated id is one comment."""
    unique = {comment.id: comment for comment in (*first, *second)}
    return tuple(sorted(unique.values(), key=lambda comment: comment.id))


def _issue_entries(items: object) -> list[dict]:
    """Issue entries with a plain positive number; the issues list also holds pull requests."""
    return [
        entry for entry in _objects(items)
        if "pull_request" not in entry and _integer(entry.get("number")) > 0
    ]


def _first_of_each(entries: list[dict], seen: set[int]) -> list[dict]:
    """Entries whose number is not in `seen` yet, the first occurrence of each; `seen` grows."""
    fresh = []
    for entry in entries:
        if entry["number"] not in seen:
            seen.add(entry["number"])
            fresh.append(entry)
    return fresh


def _unfinished(entry: dict) -> bool:
    return any(name.startswith("status:") and name != DONE_STATUS for name in _labels(entry))


def _issue(
    entry: dict, is_open: bool, trigger_actor: str | None, comments: tuple[Comment, ...],
    pull_request: PullRequest | None, *, unreadable: bool = False,
) -> Issue:
    return Issue(
        number=entry["number"],
        title=_text(entry.get("title")),
        body=_text(entry.get("body")),
        author=_login(entry.get("user")),
        open=is_open,
        labels=_labels(entry),
        trigger_actor=trigger_actor,
        comments=comments,
        pull_request=pull_request,
        unreadable=unreadable,
    )


def _pull_request_of(github: GitHub, number: int) -> PullRequest | None:
    owner = github.repo.removeprefix("/repos/").split("/")[0]
    pulls = github.get(
        f"{github.repo}/pulls", {"head": f"{owner}:{branch_for(number)}", "state": "all", "per_page": "10"}
    )
    return _pull_request(pulls)


def _open_pull_details(
    github: GitHub, pull: PullRequest, config: Config
) -> tuple[PullRequest, tuple[Comment, ...]]:
    """The open pull request with its checks, review verdict and reviews, and its comments."""
    comments = _sorted_comments(github.get_all(f"{github.repo}/issues/{pull.number}/comments", {"per_page": "100"}))
    reviews = _reviews(github.get_all(f"{github.repo}/pulls/{pull.number}/reviews", {"per_page": "100"}))
    checks: tuple[Check, ...] = ()
    verdict = text = ""
    if _SHA.fullmatch(pull.head_sha):  # the head goes into a request path, so only a full commit id may
        checks = _checks(github.get(f"{github.repo}/commits/{pull.head_sha}/check-runs", {"per_page": "100"}))
        verdict, text = _verdict(comments, pull.head_sha, config)
    return replace(pull, checks=checks, verdict=verdict, review_text=text, reviews=reviews), comments


def _open_issue(github: GitHub, entry: dict, config: Config) -> Issue:
    """An open issue with its history, or unreadable when GitHub refuses part of it.

    Anyone can fill an issue until a read of it fails (a page too large, too many pages), and that must not stop
    the poll for every other issue. A rate limit is GitHub's and not the issue's, so it still ends the poll.
    """
    number = entry["number"]
    try:
        events = github.get_all(f"{github.repo}/issues/{number}/events", {"per_page": "100"})
        raw_comments = github.get_all(f"{github.repo}/issues/{number}/comments", {"per_page": "100"})
        pull_request = _pull_request_of(github, number)
        pull_comments: tuple[Comment, ...] = ()
        if pull_request is not None and pull_request.open:
            pull_request, pull_comments = _open_pull_details(github, pull_request, config)
    except RateLimited:
        raise
    except GitHubError:
        return _issue(entry, True, None, (), None, unreadable=True)
    comments = _merged(_sorted_comments(raw_comments), pull_comments)
    return _issue(entry, True, _trigger_actor(events), comments, pull_request)


def _halted(github: GitHub) -> bool:
    """True when a halt issue is open; an answer that is not an empty list halts: stopping is the safe reading."""
    answer = github.get(f"{github.repo}/issues", {"state": "open", "labels": HALT_LABEL, "per_page": "1"})
    return not (isinstance(answer, list) and not answer)


def _apps(github: GitHub) -> tuple[str, ...]:
    entries = github.get(f"{github.repo}/contents/apps")
    return tuple(sorted(_text(e.get("name")) for e in _objects(entries) if e.get("type") == "dir" and _text(e.get("name"))))


def fetch(github: GitHub, config: Config) -> Snapshot:
    """Read the issues, the halt switch and the apps.

    A GitHubError from a list, or a rate limit anywhere, ends the poll without a snapshot; any other GitHubError
    while reading one open issue's history makes that issue unreadable instead.
    """
    open_entries = _issue_entries(
        github.get_all(f"{github.repo}/issues", {"state": "open", "labels": FIX_LABEL, "per_page": "100"})
    )
    closed_entries = _issue_entries(
        github.get(
            f"{github.repo}/issues",
            {
                "state": "closed", "labels": FIX_LABEL, "sort": "updated", "direction": "desc",
                "per_page": str(CLOSED_ISSUES_SEEN),
            },
        )
    )
    # Pagination can repeat an issue and one can reopen between the two lists: the open list wins.
    seen: set[int] = set()
    open_entries = _first_of_each(open_entries, seen)
    closed_entries = _first_of_each(closed_entries, seen)
    issues = [_open_issue(github, entry, config) for entry in open_entries]
    issues += [
        _issue(entry, False, None, (), _pull_request_of(github, entry["number"]))
        for entry in closed_entries
        if _unfinished(entry)
    ]
    return Snapshot(tuple(issues), _halted(github), _apps(github))

"""One poll of GitHub turned into the frozen records the dispatcher's decision function reads."""

from collections.abc import Mapping
from dataclasses import dataclass

from factory import markers
from factory.config import Config
from factory.github_api import GitHub

FIX_LABEL = "factory:fix"
HALT_LABEL = "factory:halt"
DONE_STATUS = "status:done"
CLOSED_ISSUES_SEEN = 30


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
class PullRequest:
    number: int
    open: bool
    merged: bool
    url: str


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

    def markers(self, bot: Bot) -> tuple[Marker, ...]:
        """Markers in the bot's own comments, oldest first.

        The login alone is not enough: the numeric id is what GitHub guarantees to be unique, so a
        comment by another account that shows the bot's name does not count.
        """
        found = []
        for comment in self.comments:
            if comment.author != bot.login or comment.author_id != bot.user_id:
                continue
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


def _comment(raw: dict) -> Comment:
    user = raw.get("user")
    author_id = _integer(user.get("id")) if isinstance(user, dict) else 0
    return Comment(_integer(raw.get("id")), _login(user), author_id, _text(raw.get("created_at")), _text(raw.get("body")))


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
    return PullRequest(
        latest["number"], latest.get("state") == "open", latest.get("merged_at") is not None, _text(latest.get("html_url"))
    )


def _issue_entries(items: object) -> list[dict]:
    """Issue entries with a plain positive number; the issues list also holds pull requests."""
    return [
        entry for entry in _objects(items)
        if "pull_request" not in entry and _integer(entry.get("number")) > 0
    ]


def _unfinished(entry: dict) -> bool:
    return any(name.startswith("status:") and name != DONE_STATUS for name in _labels(entry))


def _issue(
    entry: dict, trigger_actor: str | None, comments: tuple[Comment, ...], pull_request: PullRequest | None
) -> Issue:
    return Issue(
        number=entry["number"],
        title=_text(entry.get("title")),
        body=_text(entry.get("body")),
        author=_login(entry.get("user")),
        open=entry.get("state") == "open",
        labels=_labels(entry),
        trigger_actor=trigger_actor,
        comments=comments,
        pull_request=pull_request,
    )


def _pull_request_of(github: GitHub, number: int) -> PullRequest | None:
    owner = github.repo.removeprefix("/repos/").split("/")[0]
    pulls = github.get(
        f"{github.repo}/pulls", {"head": f"{owner}:{branch_for(number)}", "state": "all", "per_page": "10"}
    )
    return _pull_request(pulls)


def _open_issue(github: GitHub, entry: dict) -> Issue:
    number = entry["number"]
    events = github.get_all(f"{github.repo}/issues/{number}/events", {"per_page": "100"})
    raw_comments = github.get_all(f"{github.repo}/issues/{number}/comments", {"per_page": "100"})
    comments = tuple(sorted((_comment(raw) for raw in _objects(raw_comments)), key=lambda comment: comment.id))
    return _issue(entry, _trigger_actor(events), comments, _pull_request_of(github, number))


def _halted(github: GitHub) -> bool:
    answer = github.get(f"{github.repo}/issues", {"state": "open", "labels": HALT_LABEL, "per_page": "1"})
    # An answer that is not an empty list is treated as a halt: when in doubt, do nothing.
    return not (isinstance(answer, list) and not answer)


def _apps(github: GitHub) -> tuple[str, ...]:
    entries = github.get(f"{github.repo}/contents/apps")
    return tuple(sorted(_text(e.get("name")) for e in _objects(entries) if e.get("type") == "dir" and _text(e.get("name"))))


def fetch(github: GitHub, config: Config) -> Snapshot:
    """Read the issues, the halt switch and the apps; any GitHubError ends the poll without a snapshot."""
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
    issues = [_open_issue(github, entry) for entry in open_entries]
    issues += [
        _issue(entry, None, (), _pull_request_of(github, entry["number"]))
        for entry in closed_entries
        if _unfinished(entry)
    ]
    return Snapshot(tuple(issues), _halted(github), _apps(github))

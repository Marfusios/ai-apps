"""Test doubles for the GitHub client: a scripted opener and an in-memory GitHub."""

import email.message
import io
import itertools
import json
import re
import urllib.error
from collections.abc import Mapping
from dataclasses import dataclass

from factory.github_api import GitHubError

ISSUE_COMMENTS = re.compile(r"/issues/[0-9]+/comments")
FIRST_NUMBER = 1000  # the number FakeGitHub gives the first pull request or comment it creates


def message(headers: Mapping[str, str]) -> email.message.Message:
    """Headers with the case-insensitive `get` that urllib's responses have."""
    message = email.message.Message()
    for name, value in headers.items():
        message[name] = value
    return message


@dataclass(frozen=True)
class Recorded:
    method: str
    url: str
    headers: dict[str, str]  # names in lower case
    body: bytes | None


class FakeResponse:
    def __init__(self, status: int, headers: Mapping[str, str], body: bytes) -> None:
        self.status = status
        self.headers = message(headers)
        self._stream = io.BytesIO(body)

    def read(self, amount: int = -1) -> bytes:
        return self._stream.read(amount)

    def close(self) -> None:
        self._stream.close()


class FakeOpener:
    """Answers requests in order from `(method, url suffix, status, headers, body)` tuples.

    Like `urllib.request.urlopen`, it raises HTTPError for 304 and for statuses of 400 and more.
    A body that is not bytes or text is sent as JSON. Where the status is an exception, it is raised.
    """

    def __init__(self, answers: list[tuple]) -> None:
        self._pending = list(answers)
        self.requests: list[Recorded] = []

    def __call__(self, request, timeout=None):
        recorded = Recorded(
            request.get_method(),
            request.full_url,
            {name.lower(): value for name, value in request.header_items()},
            request.data,
        )
        self.requests.append(recorded)
        if not self._pending:
            raise AssertionError(f"unexpected request {recorded.method} {recorded.url}")
        method, suffix, status, headers, body = self._pending.pop(0)
        if recorded.method != method or not recorded.url.endswith(suffix):
            raise AssertionError(f"expected {method} ...{suffix}, got {recorded.method} {recorded.url}")
        if isinstance(status, Exception):
            raise status
        data = body if isinstance(body, bytes) else body.encode() if isinstance(body, str) else json.dumps(body).encode()
        if status == 304 or status >= 400:
            raise urllib.error.HTTPError(recorded.url, status, "answer", message(headers), io.BytesIO(data))
        return FakeResponse(status, headers, data)


class FakeGitHub:
    """The public methods of `GitHub`, answering from `answers` and recording what is written.

    `answers` maps `(path, sorted params)` to what `get` returns and `get_all` lists, and `raises` maps such a key
    to the exception that reading it raises instead. `responses` maps `(method, path)` to what a `post` or `patch`
    returns. A request whose path, or whose `(method, path)`, is in `fail` raises GitHubError(502); one in
    `fail_once` raises it on the first such request only, before it has any effect; and one in `missing` raises
    GitHubError(404).

    Like GitHub, it remembers what it creates. A pull request posted to `<repo>/pulls` or a comment posted to
    `<repo>/issues/<n>/comments`, unless `responses` scripts the answer, gets the next number from FIRST_NUMBER on and
    joins every later listing of that path, whatever its params. Both are written by `user`.

    `graphql_answers` is consumed in order by `graphql`: a dict is returned, an exception is raised, and running out
    fails the test; `graphql_calls` records each `(query, variables)`. `downloads` maps a path to the text
    `download_text` returns the last `limit` characters of; a path not in it raises GitHubError(404).
    """

    def __init__(self, repository: str = "owner/name", user: Mapping[str, object] | None = None) -> None:
        self._repository = repository
        self.user = dict(user or {"login": "fake-bot[bot]", "id": 1})
        self.answers: dict[tuple[str, tuple[tuple[str, str], ...]], object] = {}
        self.raises: dict[tuple[str, tuple[tuple[str, str], ...]], Exception] = {}
        self.responses: dict[tuple[str, str], object] = {}
        self.calls: list[tuple[str, str, Mapping | None]] = []
        self.fail: set[str | tuple[str, str]] = set()
        self.fail_once: set[str | tuple[str, str]] = set()
        self.missing: set[str | tuple[str, str]] = set()
        self.graphql_answers: list[dict | Exception] = []
        self.graphql_calls: list[tuple[str, Mapping[str, object]]] = []
        self.downloads: dict[str, str] = {}
        self._created: dict[str, list[dict]] = {}
        self._numbers = itertools.count(FIRST_NUMBER)

    @property
    def repo(self) -> str:
        return f"/repos/{self._repository}"

    def get(self, path: str, params: Mapping[str, str] | None = None) -> object:
        self._check("GET", path)
        key = (path, tuple(sorted((params or {}).items())))
        if key in self.raises:
            raise self.raises[key]
        created = [dict(item) for item in self._created.get(path, [])]
        if key not in self.answers and not created:
            raise AssertionError(f"unexpected GET {key}")
        answer = self.answers.get(key, [])
        return [*answer, *created] if created else answer

    def get_all(self, path: str, params: Mapping[str, str] | None = None, *, max_pages: int = 10) -> list:
        answer = self.get(path, params)
        if not isinstance(answer, list):
            raise AssertionError(f"the answer for GET {path} is not a list")
        return list(answer)

    def post(self, path: str, body: Mapping) -> object:
        return self._write("POST", path, body)

    def patch(self, path: str, body: Mapping) -> object:
        return self._write("PATCH", path, body)

    def delete(self, path: str) -> None:
        self._check("DELETE", path)
        self.calls.append(("DELETE", path, None))

    def graphql(self, query: str, variables: Mapping[str, object]) -> dict:
        self.graphql_calls.append((query, variables))
        if not self.graphql_answers:
            raise AssertionError("unexpected GraphQL call")
        answer = self.graphql_answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    def download_text(self, path: str, limit: int) -> str:
        self._check("GET", path)
        if path not in self.downloads:
            raise GitHubError(404, f"GET {path} was not found")
        text = self.downloads[path]
        return text[max(0, len(text) - limit):]

    def posted(self, path: str) -> Mapping:
        """The body of the last post to `path`; fails the test when there was none."""
        for method, called, body in reversed(self.calls):
            if method == "POST" and called == path and body is not None:
                return body
        raise AssertionError(f"nothing was posted to {path}")

    def _write(self, method: str, path: str, body: Mapping) -> object:
        self._check(method, path)
        self.calls.append((method, path, body))
        if (method, path) in self.responses:
            return self.responses[(method, path)]
        if method == "POST" and path == f"{self.repo}/pulls":
            number = next(self._numbers)
            return self._create(path, {
                "number": number, "html_url": f"https://github.com/{self._repository}/pull/{number}", "state": "open",
                "draft": body.get("draft", False), "title": body.get("title"), "body": body.get("body"),
                "head": {"ref": body.get("head")}, "base": {"ref": body.get("base")}, "user": dict(self.user),
            })
        if method == "POST" and path.startswith(self.repo) and ISSUE_COMMENTS.fullmatch(path[len(self.repo):]):
            return self._create(path, {
                "id": next(self._numbers), "user": dict(self.user), "created_at": "2026-01-01T00:00:00Z",
                "body": body.get("body"),
            })
        return {}

    def _create(self, path: str, item: dict) -> dict:
        self._created.setdefault(path, []).append(item)
        return dict(item)

    def _check(self, method: str, path: str) -> None:
        keys = (path, (method, path))
        once = [key for key in keys if key in self.fail_once]
        if once:
            self.fail_once.difference_update(once)
            raise GitHubError(502, f"{method} {path} failed")
        if any(key in self.fail for key in keys):
            raise GitHubError(502, f"{method} {path} failed")
        if any(key in self.missing for key in keys):
            raise GitHubError(404, f"{method} {path} was not found")

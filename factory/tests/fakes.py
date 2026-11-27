"""Test doubles for the GitHub client: a scripted opener and an in-memory GitHub."""

import email.message
import io
import json
import urllib.error
from collections.abc import Mapping
from dataclasses import dataclass

from factory.github_api import GitHubError


def _message(headers: Mapping[str, str]) -> email.message.Message:
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
        self.headers = _message(headers)
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
            raise urllib.error.HTTPError(recorded.url, status, "answer", _message(headers), io.BytesIO(data))
        return FakeResponse(status, headers, data)


class FakeGitHub:
    """The public methods of `GitHub`, answering from `answers` and recording what is written.

    `answers` maps `(path, sorted params)` to what `get` returns and `get_all` lists. `responses` maps
    `(method, path)` to what a `post` or `patch` returns. Every path in `fail` raises GitHubError(502).
    """

    def __init__(self, repository: str = "owner/name") -> None:
        self._repository = repository
        self.answers: dict[tuple[str, tuple[tuple[str, str], ...]], object] = {}
        self.responses: dict[tuple[str, str], object] = {}
        self.calls: list[tuple[str, str, Mapping | None]] = []
        self.fail: set[str] = set()

    @property
    def repo(self) -> str:
        return f"/repos/{self._repository}"

    def get(self, path: str, params: Mapping[str, str] | None = None) -> object:
        self._check(path)
        key = (path, tuple(sorted((params or {}).items())))
        if key not in self.answers:
            raise AssertionError(f"unexpected GET {key}")
        return self.answers[key]

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
        self._check(path)
        self.calls.append(("DELETE", path, None))

    def posted(self, path: str) -> Mapping:
        """The body of the last post to `path`; fails the test when there was none."""
        for method, called, body in reversed(self.calls):
            if method == "POST" and called == path and body is not None:
                return body
        raise AssertionError(f"nothing was posted to {path}")

    def _write(self, method: str, path: str, body: Mapping) -> object:
        self._check(path)
        self.calls.append((method, path, body))
        return self.responses.get((method, path), {})

    def _check(self, path: str) -> None:
        if path in self.fail:
            raise GitHubError(502, f"{path} failed")

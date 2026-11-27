"""A small GitHub REST client: conditional requests, pagination and typed errors."""

import http.client
import json
import math
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable, Mapping

API_ROOT = "https://api.github.com"
TIMEOUT_SECONDS = 30
MAX_BODY_BYTES = 10_000_000
MAX_REMEMBERED = 500
DEFAULT_RETRY_SECONDS = 60
NEXT_LINK = re.compile(r'<([^>]*)>\s*;\s*rel="next"')


class GitHubError(Exception):
    """A request failed; the message holds no token, query or response text.

    `status` is 0 when there is no HTTP status: a network failure, or an answer the client refused
    (not a list where one was expected, a next link off the API host, too many pages, a bad path).
    """

    def __init__(self, status: int, message: str) -> None:
        super().__init__(f"GitHub {status}: {message}")
        self.status = status
        self.message = message


class RateLimited(GitHubError):
    """GitHub asked for a pause; `retry_at` is the epoch second after which to try again."""

    def __init__(self, status: int, message: str, retry_at: float) -> None:
        super().__init__(status, message)
        self.retry_at = retry_at


def _number(text: str | None) -> float | None:
    """A finite, non-negative number from a header, else None."""
    try:
        value = float(text) if text is not None else None
    except ValueError:
        return None
    return value if value is not None and math.isfinite(value) and value >= 0 else None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Surfaces a 3xx as an HTTPError, so the token is never sent to the host a redirect names."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_default_opener = urllib.request.build_opener(NoRedirect).open


def _check_path(path: str) -> None:
    """Refuse a path that could change the host or smuggle in another line of the request."""
    if not path.startswith("/") or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in path):
        raise GitHubError(0, "the request path is not a plain path starting with a slash")


def _label(method: str, url: str) -> str:
    """Name a request in an error without its query, which could carry search text."""
    return f"{method} {urllib.parse.urlsplit(url).path}"


class GitHub:
    """Calls one repository's REST API as the token's owner."""

    def __init__(
        self,
        repository: str,
        token: Callable[[], str],
        *,
        opener: Callable = _default_opener,
        refresh: Callable[[], str] | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self._repository = repository
        self._token = token
        self._refresh = refresh or token
        self._opener = opener
        self._clock = clock
        # url -> (etag, body, next page url); insertion order is age order
        self._remembered: dict[str, tuple[str, object, str | None]] = {}

    @property
    def repo(self) -> str:
        return f"/repos/{self._repository}"

    def get(self, path: str, params: Mapping[str, str] | None = None) -> object:
        _check_path(path)
        return self._get_page(self._url(path, params))[0]

    def get_all(self, path: str, params: Mapping[str, str] | None = None, *, max_pages: int = 10) -> list:
        _check_path(path)
        url: str | None = self._url(path, params)
        items: list = []
        for _ in range(max_pages):
            body, url = self._get_page(url)
            if not isinstance(body, list):
                raise GitHubError(0, f"GET {path} did not answer with a list")
            items.extend(body)
            if url is None:
                return items
            if not url.startswith(API_ROOT + "/"):
                raise GitHubError(0, f"GET {path} points to a next page outside the API")
        raise GitHubError(0, f"GET {path} has more than {max_pages} pages")

    def post(self, path: str, body: Mapping) -> object:
        return self._write("POST", path, body)

    def patch(self, path: str, body: Mapping) -> object:
        return self._write("PATCH", path, body)

    def delete(self, path: str) -> None:
        _check_path(path)
        self._send("DELETE", API_ROOT + path, None, None)

    @staticmethod
    def _url(path: str, params: Mapping[str, str] | None) -> str:
        query = urllib.parse.urlencode(sorted((params or {}).items()))
        return f"{API_ROOT}{path}?{query}" if query else f"{API_ROOT}{path}"

    def _write(self, method: str, path: str, body: Mapping, *, retry_on_401: bool = True) -> object:
        _check_path(path)
        encoded = json.dumps(body).encode("utf-8")
        _, _, data = self._send(method, API_ROOT + path, encoded, None, retry_on_401=retry_on_401)
        return self._decode(method, API_ROOT + path, data)

    def _get_page(self, url: str) -> tuple[object, str | None]:
        """Fetch one page with the remembered ETag; returns its body and the next page's URL."""
        remembered = self._remembered.get(url)
        status, headers, data = self._send("GET", url, None, remembered[0] if remembered else None)
        if status == 304:
            if remembered is None:
                raise GitHubError(304, f"{_label('GET', url)} answered not modified for an unseen page")
            return remembered[1], remembered[2]
        body = self._decode("GET", url, data)
        match = NEXT_LINK.search(headers.get("link") or "")
        next_url = match.group(1) if match else None
        etag = headers.get("etag")
        self._remembered.pop(url, None)  # an answer without an ETag must not leave a stale one behind
        if etag:
            self._remembered[url] = (etag, body, next_url)
            if len(self._remembered) > MAX_REMEMBERED:
                del self._remembered[next(iter(self._remembered))]
        return body, next_url

    @staticmethod
    def _decode(method: str, url: str, data: bytes) -> object:
        if not data:
            return None
        try:
            return json.loads(data)
        except (ValueError, RecursionError):
            raise GitHubError(0, f"{_label(method, url)} answered a body that is not JSON") from None

    def _send(
        self, method: str, url: str, data: bytes | None, etag: str | None, *, retry_on_401: bool = True
    ) -> tuple[int, object, bytes]:
        """Send a request, once more after a 401 with a newly minted token."""
        status, headers, content = self._exchange(method, url, data, etag, self._token)
        if status == 401 and retry_on_401:
            status, headers, content = self._exchange(method, url, data, etag, self._refresh)
        label = _label(method, url)
        if status in (403, 429) and ("retry-after" in headers or headers.get("x-ratelimit-remaining") == "0"):
            raise RateLimited(status, f"{label} was rate limited", self._retry_at(headers))
        if status != 304 and not 200 <= status < 300:
            raise GitHubError(status, f"{label} failed")
        return status, headers, content

    def _retry_at(self, headers) -> float:
        now = self._clock()
        wait = _number(headers.get("retry-after"))
        if wait is not None:
            return now + wait
        reset = _number(headers.get("x-ratelimit-reset"))
        return max(reset, now) if reset is not None else now + DEFAULT_RETRY_SECONDS

    def _exchange(
        self, method: str, url: str, data: bytes | None, etag: str | None, token: Callable[[], str]
    ) -> tuple[int, object, bytes]:
        headers = {
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "factory-dispatcher",
            "Authorization": f"Bearer {token()}",
        }
        if etag:
            headers["If-None-Match"] = etag
        if data is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        label = _label(method, url)
        try:
            try:
                response = self._opener(request, timeout=TIMEOUT_SECONDS)
            except urllib.error.HTTPError as error:
                response = error  # an HTTPError is also a response: status, headers and body
            try:
                content = response.read(MAX_BODY_BYTES + 1)
            finally:
                response.close()
        except (OSError, http.client.HTTPException) as error:  # HTTPException is not an OSError
            raise GitHubError(0, f"{label} failed on the network ({type(error).__name__})") from None
        if len(content) > MAX_BODY_BYTES:
            raise GitHubError(0, f"{label} answered more than {MAX_BODY_BYTES} bytes")
        return response.status, response.headers, content


def post_as_app(path: str, bearer: str, *, opener: Callable = _default_opener) -> dict:
    """POST as the App itself with its JWT; the `post` that InstallationToken needs."""
    # The bearer is a fixed JWT, so repeating a rejected request would only repeat the rejection.
    answer = GitHub("", lambda: bearer, opener=opener)._write("POST", path, {}, retry_on_401=False)
    if not isinstance(answer, dict):
        raise GitHubError(0, f"POST {path} did not answer with an object")
    return answer

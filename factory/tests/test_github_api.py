"""Tests for the GitHub REST client, run against a scripted opener."""

import http.client
import json
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock

from factory.github_api import (
    API_ROOT,
    MAX_BODY_BYTES,
    MAX_REMEMBERED,
    GitHub,
    GitHubError,
    NoRedirect,
    RateLimited,
    post_as_app,
)
from factory.github_auth import InstallationToken
from factory.tests.fakes import FakeGitHub, FakeOpener, _message

TOKEN = "tok-" + "x" * 20
NOW = 1_800_000_000.0


def client(answers: list[tuple], token=lambda: TOKEN) -> tuple[GitHub, FakeOpener]:
    opener = FakeOpener(answers)
    return GitHub("owner/name", token, opener=opener, clock=lambda: NOW), opener


class RequestTest(unittest.TestCase):
    def test_every_request_carries_the_standard_headers_and_a_timeout(self):
        seen = {}

        class Spy(FakeOpener):
            def __call__(self, request, timeout=None):
                seen["timeout"] = timeout
                return super().__call__(request, timeout)

        opener = Spy([("GET", "/repos/owner/name", 200, {}, {"ok": True})])
        github = GitHub("owner/name", lambda: TOKEN, opener=opener)
        self.assertEqual(github.get(github.repo), {"ok": True})
        headers = opener.requests[0].headers
        self.assertEqual(headers["accept"], "application/vnd.github+json")
        self.assertEqual(headers["x-github-api-version"], "2022-11-28")
        self.assertEqual(headers["user-agent"], "factory-dispatcher")
        self.assertEqual(headers["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(seen["timeout"], 30)

    def test_params_are_encoded_and_sorted_so_the_url_is_stable(self):
        github, opener = client([("GET", "", 200, {}, [])])
        github.get("/issues", {"state": "open", "labels": "a b", "per_page": "100"})
        self.assertEqual(opener.requests[0].url, f"{API_ROOT}/issues?labels=a+b&per_page=100&state=open")

    def test_post_and_patch_send_a_json_body_and_return_the_answer(self):
        github, opener = client([("POST", "/x", 201, {}, {"id": 1}), ("PATCH", "/x/1", 200, {}, {"id": 1, "n": 2})])
        self.assertEqual(github.post("/x", {"a": 1}), {"id": 1})
        self.assertEqual(github.patch("/x/1", {"n": 2}), {"id": 1, "n": 2})
        self.assertEqual(json.loads(opener.requests[0].body), {"a": 1})
        self.assertEqual(opener.requests[0].headers["content-type"], "application/json")

    def test_delete_and_bodiless_answers_return_none(self):
        github, _ = client([("DELETE", "/x/1", 204, {}, b""), ("POST", "/x", 204, {}, b""), ("PATCH", "/x", 204, {}, b"")])
        self.assertIsNone(github.delete("/x/1"))
        self.assertIsNone(github.post("/x", {}))
        self.assertIsNone(github.patch("/x", {}))

    def test_a_404_on_delete_is_an_error_like_any_other(self):
        github, _ = client([("DELETE", "/x/1", 404, {}, {"message": "Not Found"})])
        with self.assertRaises(GitHubError) as caught:
            github.delete("/x/1")
        self.assertEqual(caught.exception.status, 404)

    def test_repo_is_the_repository_path(self):
        self.assertEqual(client([])[0].repo, "/repos/owner/name")


class ConditionalGetTest(unittest.TestCase):
    def test_second_get_sends_the_etag_and_returns_the_remembered_body(self):
        github, opener = client([
            ("GET", "/issues", 200, {"ETag": '"abc"'}, [{"n": 1}]),
            ("GET", "/issues", 304, {}, b""),
        ])
        self.assertEqual(github.get("/issues"), [{"n": 1}])
        self.assertNotIn("if-none-match", opener.requests[0].headers)
        self.assertEqual(github.get("/issues"), [{"n": 1}])
        self.assertEqual(opener.requests[1].headers["if-none-match"], '"abc"')

    def test_a_changed_page_replaces_the_remembered_body(self):
        github, _ = client([
            ("GET", "/issues", 200, {"ETag": '"a"'}, [1]),
            ("GET", "/issues", 200, {"ETag": '"b"'}, [2]),
            ("GET", "/issues", 304, {}, b""),
        ])
        github.get("/issues")
        self.assertEqual(github.get("/issues"), [2])
        self.assertEqual(github.get("/issues"), [2])

    def test_a_304_for_a_page_never_seen_is_an_error(self):
        github, _ = client([("GET", "/issues", 304, {}, b"")])
        with self.assertRaises(GitHubError):
            github.get("/issues")

    def test_the_memory_drops_the_oldest_entries_beyond_its_bound(self):
        answers = [("GET", f"/p/{i}", 200, {"ETag": f'"{i}"'}, [i]) for i in range(MAX_REMEMBERED + 1)]
        answers += [("GET", "/p/0", 200, {"ETag": '"0"'}, [0]), ("GET", f"/p/{MAX_REMEMBERED}", 304, {}, b"")]
        github, opener = client(answers)
        for i in range(MAX_REMEMBERED + 1):
            github.get(f"/p/{i}")
        github.get("/p/0")  # forgotten, so no If-None-Match
        self.assertNotIn("if-none-match", opener.requests[MAX_REMEMBERED + 1].headers)
        github.get(f"/p/{MAX_REMEMBERED}")  # still remembered
        self.assertIn("if-none-match", opener.requests[MAX_REMEMBERED + 2].headers)


class GetAllTest(unittest.TestCase):
    def link(self, page: int) -> dict:
        return {"Link": f'<{API_ROOT}/issues?page={page}>; rel="next", <{API_ROOT}/issues?page=9>; rel="last"'}

    def test_get_all_follows_next_links_and_stops_at_max_pages(self):
        github, opener = client([
            ("GET", "/issues?per_page=2", 200, self.link(2), [1, 2]),
            ("GET", "/issues?page=2", 200, self.link(3), [3, 4]),
            ("GET", "/issues?page=3", 200, {}, [5]),
        ])
        self.assertEqual(github.get_all("/issues", {"per_page": "2"}), [1, 2, 3, 4, 5])
        self.assertEqual(opener.requests[2].headers["authorization"], f"Bearer {TOKEN}")

        github, _ = client([
            ("GET", "/issues", 200, self.link(2), [1]),
            ("GET", "/issues?page=2", 200, self.link(3), [2]),
        ])
        with self.assertRaises(GitHubError):
            github.get_all("/issues", max_pages=2)

    def test_exactly_max_pages_without_a_next_link_is_complete(self):
        github, _ = client([("GET", "/issues", 200, self.link(2), [1]), ("GET", "/issues?page=2", 200, {}, [2])])
        self.assertEqual(github.get_all("/issues", max_pages=2), [1, 2])

    def test_a_next_link_outside_the_api_is_refused(self):
        github, opener = client([("GET", "/issues", 200, {"Link": '<https://evil.example/x>; rel="next"'}, [1])])
        with self.assertRaises(GitHubError):
            github.get_all("/issues")
        self.assertEqual(len(opener.requests), 1)

    def test_a_page_that_is_not_a_list_is_an_error(self):
        github, _ = client([("GET", "/issues", 200, {}, {"message": "x"})])
        with self.assertRaises(GitHubError):
            github.get_all("/issues")

    def test_a_full_page_without_a_next_link_is_fetched_fresh_so_a_new_page_is_seen(self):
        github, opener = client([
            ("GET", "/issues?per_page=2", 200, {"ETag": '"full"'}, [1, 2]),
            ("GET", "/issues?per_page=2", 200, {**self.link(2), "ETag": '"full"'}, [1, 2]),
            ("GET", "/issues?page=2", 200, {}, [3]),
        ])
        self.assertEqual(github.get_all("/issues", {"per_page": "2"}), [1, 2])
        self.assertEqual(github.get_all("/issues", {"per_page": "2"}), [1, 2, 3])
        self.assertNotIn("if-none-match", opener.requests[1].headers)

    def test_a_page_that_is_not_full_or_has_a_next_link_is_remembered(self):
        github, opener = client([
            ("GET", "/issues?per_page=2", 200, {"ETag": '"short"'}, [1]),
            ("GET", "/pulls?per_page=1", 200, {**self.link(2), "ETag": '"linked"'}, [1]),
            ("GET", "/issues?per_page=2", 304, {}, b""),
            ("GET", "/pulls?per_page=1", 304, {}, b""),
        ])
        for _ in range(2):
            github.get("/issues", {"per_page": "2"})
            github.get("/pulls", {"per_page": "1"})
        self.assertEqual([request.headers.get("if-none-match") for request in opener.requests],
                         [None, None, '"short"', '"linked"'])

    def test_pages_are_remembered_with_their_next_link(self):
        github, _ = client([
            ("GET", "/issues", 200, {**self.link(2), "ETag": '"1"'}, [1]),
            ("GET", "/issues?page=2", 200, {"ETag": '"2"'}, [2]),
            ("GET", "/issues", 304, {}, b""),
            ("GET", "/issues?page=2", 304, {}, b""),
        ])
        self.assertEqual(github.get_all("/issues"), [1, 2])
        self.assertEqual(github.get_all("/issues"), [1, 2])


class TokenRefreshTest(unittest.TestCase):
    def test_a_401_refreshes_the_token_once(self):
        tokens = iter(["old", "new", "never"])
        github, opener = client(
            [("GET", "/x", 401, {}, {}), ("GET", "/x", 200, {}, {"ok": 1})], token=lambda: next(tokens)
        )
        self.assertEqual(github.get("/x"), {"ok": 1})
        self.assertEqual([r.headers["authorization"] for r in opener.requests], ["Bearer old", "Bearer new"])

    def test_a_second_401_raises_instead_of_looping(self):
        github, opener = client([("GET", "/x", 401, {}, {}), ("GET", "/x", 401, {}, {})])
        with self.assertRaises(GitHubError) as caught:
            github.get("/x")
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(len(opener.requests), 2)


class RealTokenRefreshTest(unittest.TestCase):
    def test_a_401_mints_exactly_one_new_token_and_the_retry_carries_it(self):
        posts = []

        def post(path, bearer, repository):
            posts.append(path)
            return {"token": f"minted-{len(posts)}", "expires_at": "2099-01-01T00:00:00Z"}

        with mock.patch("factory.github_auth.app_jwt", return_value="jwt"):
            tokens = InstallationToken("1", "2", Path("key.pem"), repository="o/n", post=post)
            opener = FakeOpener([("GET", "/x", 401, {}, {}), ("GET", "/x", 200, {}, {"ok": 1})])
            github = GitHub("o/n", tokens.get, opener=opener, refresh=tokens.refresh)
            self.assertEqual(github.get("/x"), {"ok": 1})
        self.assertEqual(len(posts), 2)
        self.assertEqual([r.headers["authorization"] for r in opener.requests], ["Bearer minted-1", "Bearer minted-2"])

    def test_a_401_from_post_as_app_is_one_request(self):
        opener = FakeOpener([("POST", "/x", 401, {}, {})])
        with self.assertRaises(GitHubError) as caught:
            post_as_app("/x", "jwt", "owner/name", opener=opener)
        self.assertEqual(caught.exception.status, 401)
        self.assertEqual(len(opener.requests), 1)


class SafetyTest(unittest.TestCase):
    def test_a_redirect_is_an_error_and_is_not_followed(self):
        github, opener = client([("GET", "/x", 302, {"Location": "https://other.example/x"}, b"")])
        with self.assertRaises(GitHubError) as caught:
            github.get("/x")
        self.assertEqual(caught.exception.status, 302)
        self.assertEqual(len(opener.requests), 1)

    def test_the_default_opener_refuses_to_build_a_redirect_request(self):
        request = urllib.request.Request(f"{API_ROOT}/x", headers={"Authorization": "Bearer t"})
        self.assertIsNone(NoRedirect().redirect_request(request, None, 302, "Found", {}, "https://other.example/"))

    def test_a_path_that_could_change_the_host_or_the_request_is_refused_by_every_method(self):
        github, opener = client([])
        for path in ("@other.example/x", "x", "/a b", "/a" + chr(10) + "b", "/a" + chr(9) + "b", "/a" + chr(127) + "b"):
            for call in (
                lambda: github.get(path),
                lambda: github.get_all(path),
                lambda: github.post(path, {}),
                lambda: github.patch(path, {}),
                lambda: github.delete(path),
                lambda: post_as_app(path, "jwt", "owner/name", opener=opener),
            ):
                with self.subTest(path=path), self.assertRaises(GitHubError) as caught:
                    call()
                self.assertEqual(caught.exception.status, 0)
        self.assertEqual(opener.requests, [])

    def test_http_client_exceptions_become_github_errors(self):
        github, _ = client([
            ("GET", "/x", http.client.InvalidURL("bad"), {}, b""),
            ("GET", "/x", http.client.IncompleteRead(b"par"), {}, b""),
            ("GET", "/x", http.client.BadStatusLine("junk"), {}, b""),
        ])
        for _ in range(3):
            with self.assertRaises(GitHubError) as caught:
                github.get("/x")
            self.assertEqual(caught.exception.status, 0)

    def test_a_deeply_nested_body_is_a_github_error(self):
        github, _ = client([("GET", "/x", 200, {}, b"[" * 100_000)])
        with self.assertRaises(GitHubError):
            github.get("/x")

    def test_unusable_retry_hints_fall_back_to_the_default(self):
        for hint in ("nan", "inf", "-5", "soon", "-inf"):
            for name in ("retry-after", "x-ratelimit-reset"):
                with self.subTest(hint=hint, name=name):
                    github, _ = client([("GET", "/x", 429, {name: hint, "x-ratelimit-remaining": "0"}, {})])
                    with self.assertRaises(RateLimited) as caught:
                        github.get("/x")
                    self.assertEqual(caught.exception.retry_at, NOW + 60)

    def test_a_reset_in_the_past_means_retry_now(self):
        github, _ = client([("GET", "/x", 403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "5"}, {})])
        with self.assertRaises(RateLimited) as caught:
            github.get("/x")
        self.assertEqual(caught.exception.retry_at, NOW)

    def test_an_answer_without_an_etag_forgets_the_old_one(self):
        github, opener = client([
            ("GET", "/x", 200, {"ETag": '"a"'}, [1]),
            ("GET", "/x", 200, {}, [2]),
            ("GET", "/x", 200, {}, [3]),
        ])
        for _ in range(3):
            github.get("/x")
        self.assertIn("if-none-match", opener.requests[1].headers)
        self.assertNotIn("if-none-match", opener.requests[2].headers)


class ErrorTest(unittest.TestCase):
    def test_rate_limit_answers_raise_rate_limited_with_the_reset_time(self):
        github, _ = client([
            ("GET", "/x", 403, {"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000300"}, {}),
            ("GET", "/x", 429, {"retry-after": "17"}, {}),
            ("GET", "/x", 403, {"x-ratelimit-remaining": "0"}, {}),
        ])
        with self.assertRaises(RateLimited) as reset:
            github.get("/x")
        self.assertEqual(reset.exception.retry_at, 1_800_000_300)
        self.assertEqual(reset.exception.status, 403)
        with self.assertRaises(RateLimited) as after:
            github.get("/x")
        self.assertEqual(after.exception.retry_at, NOW + 17)
        with self.assertRaises(RateLimited) as unknown:
            github.get("/x")
        self.assertEqual(unknown.exception.retry_at, NOW + 60)

    def test_every_429_is_a_rate_limit(self):
        github, _ = client([("GET", "/x", 429, {}, {}), ("GET", "/x", 429, {"x-ratelimit-remaining": "42"}, {})])
        for _ in range(2):
            with self.assertRaises(RateLimited) as caught:
                github.get("/x")
            self.assertEqual((caught.exception.status, caught.exception.retry_at), (429, NOW + 60))

    def test_a_403_without_rate_limit_signs_is_a_plain_github_error(self):
        github, _ = client([("GET", "/x", 403, {"x-ratelimit-remaining": "42"}, {})])
        with self.assertRaises(GitHubError) as caught:
            github.get("/x")
        self.assertNotIsInstance(caught.exception, RateLimited)
        self.assertEqual(caught.exception.status, 403)

    def test_a_502_a_network_error_and_a_non_json_body_raise_github_error(self):
        github, _ = client([
            ("GET", "/x", 502, {}, "bad gateway"),
            ("GET", "/x", urllib.error.URLError("refused"), {}, b""),
            ("GET", "/x", TimeoutError("timed out"), {}, b""),
            ("GET", "/x", 200, {}, "<html>"),
        ])
        statuses = []
        for _ in range(4):
            with self.assertRaises(GitHubError) as caught:
                github.get("/x")
            statuses.append(caught.exception.status)
        self.assertEqual(statuses, [502, 0, 0, 0])

    def test_a_response_over_the_size_limit_is_refused(self):
        github, _ = client([("GET", "/x", 200, {}, b"[" + b" " * MAX_BODY_BYTES + b"]")])
        with self.assertRaises(GitHubError) as caught:
            github.get("/x")
        self.assertEqual(caught.exception.status, 0)

    def test_no_error_message_contains_the_token_or_a_request_body(self):
        secret_body = {"note": "body-" + "s" * 12}
        github, _ = client([
            ("POST", "/x", 500, {}, "echo " + TOKEN),
            ("POST", "/x", urllib.error.URLError("failed with " + TOKEN), {}, b""),
            ("POST", "/x", 429, {"retry-after": "1"}, TOKEN),
            ("POST", "/x", 200, {}, "not json " + TOKEN),
        ])
        for _ in range(4):
            with self.assertRaises(GitHubError) as caught:
                github.post("/x", secret_body)
            for text in (str(caught.exception), caught.exception.message):
                self.assertNotIn(TOKEN, text)
                self.assertNotIn("body-", text)


class PostAsAppTest(unittest.TestCase):
    def test_it_posts_with_the_jwt_as_bearer_and_returns_the_object(self):
        opener = FakeOpener([("POST", "/app/installations/1/access_tokens", 201, {}, {"token": "t"})])
        self.assertEqual(post_as_app("/app/installations/1/access_tokens", "the-jwt", "owner/name", opener=opener),
                         {"token": "t"})
        self.assertEqual(opener.requests[0].headers["authorization"], "Bearer the-jwt")

    def test_the_token_is_asked_for_this_repository_only(self):
        opener = FakeOpener([("POST", "/app/installations/1/access_tokens", 201, {}, {"token": "t"})])
        post_as_app("/app/installations/1/access_tokens", "the-jwt", "owner/name", opener=opener)
        self.assertEqual(json.loads(opener.requests[0].body), {"repositories": ["name"]})

    def test_an_answer_that_is_not_an_object_is_an_error(self):
        opener = FakeOpener([("POST", "/x", 201, {}, [1])])
        with self.assertRaises(GitHubError):
            post_as_app("/x", "the-jwt", "owner/name", opener=opener)


class GraphQLTest(unittest.TestCase):
    def test_it_posts_the_query_and_variables_and_returns_data(self):
        github, opener = client([("POST", "/graphql", 200, {}, {"data": {"viewer": {"id": 1}}})])
        self.assertEqual(github.graphql("query { viewer { id } }", {"n": 3}), {"viewer": {"id": 1}})
        self.assertEqual(json.loads(opener.requests[0].body), {"query": "query { viewer { id } }", "variables": {"n": 3}})
        self.assertEqual(opener.requests[0].headers["authorization"], f"Bearer {TOKEN}")

    def test_a_401_refreshes_the_token_like_any_write(self):
        tokens = iter(["old", "new"])
        github, opener = client(
            [("POST", "/graphql", 401, {}, {}), ("POST", "/graphql", 200, {}, {"data": {}})], token=lambda: next(tokens)
        )
        self.assertEqual(github.graphql("q", {}), {})
        self.assertEqual([r.headers["authorization"] for r in opener.requests], ["Bearer old", "Bearer new"])

    def test_a_rate_limit_is_raised_as_rate_limited(self):
        github, _ = client([("POST", "/graphql", 429, {"retry-after": "9"}, {})])
        with self.assertRaises(RateLimited) as caught:
            github.graphql("q", {})
        self.assertEqual(caught.exception.retry_at, NOW + 9)

    def test_errors_and_a_missing_or_wrong_data_raise_without_query_variables_or_error_text(self):
        for answer in (
            {"data": {"a": 1}, "errors": [{"message": "secret-text"}, {"message": "more"}]},
            {"errors": [{"message": "secret-text"}]},
            {"errors": "secret-text"},
            {"data": None},
            {"data": [1]},
            {},
            [1],
        ):
            with self.subTest(answer=answer):
                github, _ = client([("POST", "/graphql", 200, {}, answer)])
                with self.assertRaises(GitHubError) as caught:
                    github.graphql("query-" + "q" * 8, {"name": "var-" + "v" * 8})
                self.assertEqual(caught.exception.status, 0)
                for text in (str(caught.exception), caught.exception.message):
                    for leaked in ("query-", "var-", "secret-text"):
                        self.assertNotIn(leaked, text)

    def test_the_message_counts_the_errors(self):
        github, _ = client([("POST", "/graphql", 200, {}, {"errors": [{}, {}, {}]})])
        with self.assertRaises(GitHubError) as caught:
            github.graphql("q", {})
        self.assertIn("3 errors", caught.exception.message)


SIGNED = "https://logs.example/signed?sig=" + "k" * 12


def redirect(location: str = SIGNED) -> tuple:
    return ("GET", "/jobs/7/logs", 302, {"Location": location}, b"")


class DownloadTextTest(unittest.TestCase):
    def test_it_follows_one_redirect_without_the_token_or_other_client_headers(self):
        github, opener = client([redirect(), ("GET", "", 200, {}, "line one\nline two")])
        self.assertEqual(github.download_text("/jobs/7/logs", 1000), "line one\nline two")
        first, second = opener.requests
        self.assertEqual(first.url, f"{API_ROOT}/jobs/7/logs")
        self.assertEqual(first.headers["authorization"], f"Bearer {TOKEN}")
        self.assertEqual(second.url, SIGNED)
        self.assertNotIn("authorization", second.headers)
        self.assertEqual(second.headers, {"user-agent": "factory-dispatcher"})

    def test_both_requests_use_the_timeout_and_neither_follows_a_redirect(self):
        seen = []

        class Spy(FakeOpener):
            def __call__(self, request, timeout=None):
                seen.append(timeout)
                return super().__call__(request, timeout)

        opener = Spy([redirect(), ("GET", "", 302, {"Location": "https://elsewhere.example/x"}, b"")])
        github = GitHub("owner/name", lambda: TOKEN, opener=opener)
        with self.assertRaises(GitHubError):
            github.download_text("/jobs/7/logs", 10)
        self.assertEqual(seen, [30, 30])
        self.assertEqual(len(opener.requests), 2)

    def test_a_direct_200_answer_is_the_body(self):
        github, opener = client([("GET", "/jobs/7/logs", 200, {}, "direct")])
        self.assertEqual(github.download_text("/jobs/7/logs", 100), "direct")
        self.assertEqual(len(opener.requests), 1)

    def test_it_returns_only_the_tail_of_a_body_longer_than_the_limit(self):
        body = "".join(f"{i:04d}\n" for i in range(2000))
        github, _ = client([redirect(), ("GET", "", 200, {}, body)])
        self.assertEqual(github.download_text("/jobs/7/logs", 12), body[-12:])

    def test_a_body_within_the_limit_is_returned_whole_and_a_zero_limit_is_empty(self):
        github, _ = client([redirect(), ("GET", "", 200, {}, "abc"), redirect(), ("GET", "", 200, {}, "abc")])
        self.assertEqual(github.download_text("/jobs/7/logs", 3), "abc")
        self.assertEqual(github.download_text("/jobs/7/logs", 0), "")

    def test_the_body_is_read_in_bounded_chunks_never_all_at_once(self):
        amounts = []

        class Stream:
            status = 200
            headers = {}

            def __init__(self):
                self.left = 40

            def read(self, amount=-1):
                amounts.append(amount)
                if not self.left:
                    return b""
                self.left -= 1
                return b"y" * amount

            def close(self):
                pass

        def opener(request, timeout=None):
            if request.full_url.startswith(API_ROOT):
                raise urllib.error.HTTPError(request.full_url, 302, "Found", _message({"Location": SIGNED}), None)
            return Stream()

        text = GitHub("o/n", lambda: TOKEN, opener=opener).download_text("/x", 100)
        self.assertEqual(text, "y" * 100)
        self.assertTrue(all(0 < amount <= 1_000_000 for amount in amounts))

    def test_a_decoding_error_is_replaced(self):
        github, _ = client([redirect(), ("GET", "", 200, {}, b"ok \xff\xfe end")])
        self.assertEqual(github.download_text("/jobs/7/logs", 100), "ok �� end")

    def test_a_body_over_the_total_cap_is_an_error(self):
        class Endless:
            status = 200
            headers = {}

            def read(self, amount=-1):
                return b"z" * amount

            def close(self):
                pass

        def opener(request, timeout=None):
            if request.full_url.startswith(API_ROOT):
                raise urllib.error.HTTPError(request.full_url, 302, "Found", _message({"Location": SIGNED}), None)
            return Endless()

        with mock.patch("factory.github_api.MAX_DOWNLOAD_BYTES", 1_000_000):
            with self.assertRaises(GitHubError) as caught:
                GitHub("o/n", lambda: TOKEN, opener=opener).download_text("/jobs/7/logs", 10)
        self.assertEqual(caught.exception.status, 0)

    def test_a_location_that_is_not_https_or_is_missing_is_refused_without_a_second_request(self):
        for headers in ({"Location": "http://logs.example/x"}, {"Location": "file:///etc/x"}, {"Location": "/rel"}, {}):
            with self.subTest(headers=headers):
                github, opener = client([("GET", "/jobs/7/logs", 302, headers, b"")])
                with self.assertRaises(GitHubError):
                    github.download_text("/jobs/7/logs", 10)
                self.assertEqual(len(opener.requests), 1)

    def test_other_statuses_and_network_errors_raise_naming_the_path_only(self):
        cases = {
            "404 first": [("GET", "/jobs/7/logs", 404, {}, "nope")],
            "301 first": [("GET", "/jobs/7/logs", 301, {"Location": SIGNED}, b"")],
            "204 second": [redirect(), ("GET", "", 204, {}, b"")],
            "403 second": [redirect(), ("GET", "", 403, {}, "denied " + SIGNED)],
            "network first": [("GET", "/jobs/7/logs", urllib.error.URLError("failed"), {}, b"")],
            "network second": [redirect(), ("GET", "", urllib.error.URLError("failed " + SIGNED), {}, b"")],
            "timeout second": [redirect(), ("GET", "", TimeoutError("timed out"), {}, b"")],
            "http client second": [redirect(), ("GET", "", http.client.IncompleteRead(b"x"), {}, b"")],
        }
        for name, answers in cases.items():
            with self.subTest(name):
                github, _ = client(answers)
                with self.assertRaises(GitHubError) as caught:
                    github.download_text("/jobs/7/logs", 10)
                self.assertIn("/jobs/7/logs", caught.exception.message)
                for text in (str(caught.exception), caught.exception.message):
                    self.assertNotIn("sig=", text)
                    self.assertNotIn("logs.example", text)

    def test_a_read_that_fails_midway_is_a_github_error(self):
        class Broken:
            status = 200
            headers = {}

            def read(self, amount=-1):
                raise ConnectionResetError("reset " + SIGNED)

            def close(self):
                pass

        def opener(request, timeout=None):
            if request.full_url.startswith(API_ROOT):
                raise urllib.error.HTTPError(request.full_url, 302, "Found", _message({"Location": SIGNED}), None)
            return Broken()

        with self.assertRaises(GitHubError) as caught:
            GitHub("o/n", lambda: TOKEN, opener=opener).download_text("/jobs/7/logs", 10)
        self.assertNotIn("sig=", str(caught.exception))

    def test_the_path_is_validated_like_every_other(self):
        github, opener = client([])
        for path in ("x", "/a b", "@other.example/x"):
            with self.subTest(path=path), self.assertRaises(GitHubError):
                github.download_text(path, 10)
        self.assertEqual(opener.requests, [])


class FakeGitHubGraphQLAndDownloadsTest(unittest.TestCase):
    def test_graphql_answers_are_consumed_in_order_and_calls_recorded(self):
        fake = FakeGitHub()
        fake.graphql_answers = [{"a": 1}, GitHubError(0, "failed")]
        self.assertEqual(fake.graphql("q1", {"x": 1}), {"a": 1})
        with self.assertRaises(GitHubError):
            fake.graphql("q2", {})
        self.assertEqual(fake.graphql_calls, [("q1", {"x": 1}), ("q2", {})])
        with self.assertRaises(AssertionError):
            fake.graphql("q3", {})

    def test_downloads_return_the_tail_and_a_missing_path_is_a_404(self):
        fake = FakeGitHub()
        fake.downloads["/jobs/1/logs"] = "abcdef"
        self.assertEqual(fake.download_text("/jobs/1/logs", 100), "abcdef")
        self.assertEqual(fake.download_text("/jobs/1/logs", 2), "ef")
        self.assertEqual(fake.download_text("/jobs/1/logs", 0), "")
        with self.assertRaises(GitHubError) as caught:
            fake.download_text("/jobs/2/logs", 10)
        self.assertEqual(caught.exception.status, 404)


class FakeGitHubTest(unittest.TestCase):
    def test_it_answers_records_and_fails_like_the_client(self):
        fake = FakeGitHub()
        fake.answers[("/issues", (("labels", "a"), ("state", "open")))] = [{"number": 1}]
        fake.responses[("POST", "/issues")] = {"number": 2}
        fake.fail.add("/broken")
        self.assertEqual(fake.repo, "/repos/owner/name")
        self.assertEqual(fake.get_all("/issues", {"state": "open", "labels": "a"}), [{"number": 1}])
        self.assertEqual(fake.post("/issues", {"title": "t"}), {"number": 2})
        self.assertEqual(fake.patch("/issues/2", {"state": "closed"}), {})
        fake.delete("/issues/2")
        self.assertEqual(fake.posted("/issues"), {"title": "t"})
        self.assertEqual(
            fake.calls,
            [("POST", "/issues", {"title": "t"}), ("PATCH", "/issues/2", {"state": "closed"}),
             ("DELETE", "/issues/2", None)],
        )
        with self.assertRaises(GitHubError) as caught:
            fake.post("/broken", {})
        self.assertEqual(caught.exception.status, 502)
        with self.assertRaises(AssertionError):
            fake.get("/unknown")
        with self.assertRaises(AssertionError):
            fake.posted("/never")


if __name__ == "__main__":
    unittest.main()

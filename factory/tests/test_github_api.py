"""Tests for the GitHub REST client, run against a scripted opener."""

import json
import unittest
import urllib.error

from factory.github_api import API_ROOT, MAX_BODY_BYTES, MAX_REMEMBERED, GitHub, GitHubError, RateLimited, post_as_app
from factory.tests.fakes import FakeGitHub, FakeOpener

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
        self.assertEqual(post_as_app("/app/installations/1/access_tokens", "the-jwt", opener=opener), {"token": "t"})
        self.assertEqual(opener.requests[0].headers["authorization"], "Bearer the-jwt")

    def test_an_answer_that_is_not_an_object_is_an_error(self):
        opener = FakeOpener([("POST", "/x", 201, {}, [1])])
        with self.assertRaises(GitHubError):
            post_as_app("/x", "the-jwt", opener=opener)


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

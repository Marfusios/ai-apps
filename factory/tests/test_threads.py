"""Tests for reading a pull request's review threads, against the in-memory GitHub."""

import unittest

from factory import jobs, threads
from factory.github_api import GitHubError, GraphQLRefused
from factory.tests.fakes import FakeGitHub

AUTHOR = "someone"


def comment(database_id: object, body: str = "A remark.", *, review: object = 7, author: object = AUTHOR) -> dict:
    return {"databaseId": database_id, "author": None if author is None else {"login": author}, "body": body,
            "pullRequestReview": None if review is None else {"databaseId": review}}


def thread(thread_id: object, comments: list, *, resolved: object = False, path: object = "a/b.py",
           line: object = 3, more_comments: object = False) -> dict:
    return {"id": thread_id, "isResolved": resolved, "path": path, "line": line,
            "comments": {"pageInfo": {"hasNextPage": more_comments}, "nodes": comments}}


def answer(*nodes: object, more: object = False) -> dict:
    return {"repository": {"pullRequest": {"reviewThreads": {"pageInfo": {"hasNextPage": more},
                                                              "nodes": list(nodes)}}}}


class FetchTest(unittest.TestCase):
    def setUp(self):
        self.github = FakeGitHub()

    def fetch(self, *nodes: object, more: object = False, reviews: tuple[int, ...] = (7,)) -> threads.ReviewThreads:
        self.github.graphql_answers.append(answer(*nodes, more=more))
        return threads.fetch(self.github, "owner", "name", 40, reviews)

    def ids(self, *nodes: object, **fields) -> list[str]:
        return [item.id for item in self.fetch(*nodes, **fields).threads]

    def test_one_query_with_the_pull_request_in_its_variables_only(self):
        self.fetch()
        ((query, variables),) = self.github.graphql_calls
        self.assertEqual(variables, {"owner": "owner", "name": "name", "number": 40})
        self.assertEqual(query.count("hasNextPage"), 2)

    def test_a_thread_is_read_with_its_place_comments_and_first_comment(self):
        (found,) = self.fetch(thread("T1", [comment(11, "One"), comment(12, "Two", author="other")], line=None)).threads
        self.assertEqual(found, jobs.Thread("T1", "a/b.py", 0, 11, ((AUTHOR, "One"), ("other", "Two"))))

    def test_only_unresolved_threads_with_a_comment_of_a_wanted_review_are_kept(self):
        self.assertEqual(self.ids(
            thread("keep", [comment(1, review=8), comment(2)]),
            thread("resolved", [comment(3)], resolved=True),
            thread("other", [comment(4, review=8)]),
            thread("none", [comment(5, review=None)]),
        ), ["keep"])

    def test_no_review_to_answer_keeps_nothing(self):
        self.assertEqual(self.ids(thread("T", [comment(1)]), reviews=()), [])

    def test_odd_threads_are_left_out_and_raise_nothing(self):
        good = comment(601)
        self.assertEqual(self.ids(
            None, 5, "text", {},
            thread(5, [good]), thread("flag", [good], resolved="no"), thread("path", [good], path=None),
            thread("line", [good], line="3"), thread("bool", [comment(True)]),
            {**thread("comments", [good]), "comments": None}, thread("empty", []),
            thread("ok", [good], line=None),
        ), ["ok"])

    def test_a_comment_needs_a_positive_integer_id_and_so_does_its_review(self):
        for odd in (0, -5, "9", True, None, 1.5):
            with self.subTest(comment_id=odd):
                self.assertEqual(self.ids(thread("T", [comment(1), comment(odd)])), ["T"])
                (found,) = self.fetch(thread("T", [comment(1), comment(odd)])).threads
                self.assertEqual(len(found.comments), 1)
            with self.subTest(review_id=odd):
                if odd is not None:  # a comment of no review is fine
                    (found,) = self.fetch(thread("T", [comment(1), comment(2, review=odd)])).threads
                    self.assertEqual(len(found.comments), 1)

    def test_odd_comments_are_dropped_one_by_one(self):
        first = comment(1)
        (found,) = self.fetch(thread("T", [first, None, 7, comment(2, author=None), comment(3, "x"),
                                           {**comment(4), "body": None}])).threads
        self.assertEqual([body for _, body in found.comments], ["A remark.", "x"])

    def test_a_thread_whose_first_comment_is_odd_is_left_out_whole(self):
        for odd in (None, comment(0), comment(-5), comment(2, author=None), comment(3, review="7")):
            with self.subTest(first=odd):
                self.assertEqual(self.ids(thread("T", [odd, comment(9)])), [])

    def test_a_first_comment_of_no_review_still_gives_the_thread_when_a_later_one_is_wanted(self):
        (found,) = self.fetch(thread("T", [comment(1, review=None), comment(2)])).threads
        self.assertEqual(found.first_comment_id, 1)

    def test_more_threads_than_a_page_are_reported_and_the_first_page_is_given(self):
        result = self.fetch(thread("T", [comment(1)]), more=True)
        self.assertEqual(([item.id for item in result.threads], result.more_threads), (["T"], True))
        self.assertFalse(self.fetch(thread("T", [comment(1)]), more="yes").more_threads)
        self.assertFalse(self.fetch(thread("T", [comment(1)])).more_threads)

    def test_a_thread_with_more_comments_than_a_page_is_still_given_with_those_read(self):
        (found,) = self.fetch(thread("T", [comment(1), comment(2)], more_comments=True)).threads
        self.assertEqual(len(found.comments), 2)

    def test_an_answer_without_a_list_of_threads_raises_github_error(self):
        for body in ({}, {"repository": None}, {"repository": {"pullRequest": {"reviewThreads": {"nodes": None}}}},
                     {"repository": {"pullRequest": {"reviewThreads": {"nodes": {}}}}}):
            with self.subTest(body=body):
                self.github.graphql_answers.append(body)
                with self.assertRaises(GitHubError):
                    threads.fetch(self.github, "owner", "name", 40, (7,))

    def test_a_refused_or_failed_call_raises_what_the_client_raised(self):
        for error in (GraphQLRefused(0, "refused"), GitHubError(502, "down")):
            self.github.graphql_answers.append(error)
            with self.assertRaises(type(error)):
                threads.fetch(self.github, "owner", "name", 40, (7,))


if __name__ == "__main__":
    unittest.main()

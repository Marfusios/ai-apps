"""Read the unresolved review threads of a pull request that a revise run has to answer."""

from collections.abc import Collection
from dataclasses import dataclass

from factory import jobs
from factory.github_api import GitHub, GitHubError

MAX_THREADS = 100
MAX_THREAD_COMMENTS = 50
QUERY = """
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: %d) {
        pageInfo { hasNextPage }
        nodes {
          id
          isResolved
          path
          line
          comments(first: %d) {
            nodes { databaseId author { login } body pullRequestReview { databaseId } }
          }
        }
      }
    }
  }
}
""" % (MAX_THREADS, MAX_THREAD_COMMENTS)


@dataclass(frozen=True)
class ReviewThreads:
    """The threads to answer, and whether GitHub has more threads than the one page that was read."""

    threads: tuple[jobs.Thread, ...]
    more_threads: bool


@dataclass(frozen=True)
class _Comment:
    id: int
    author: str
    body: str
    review: int | None


def fetch(github: GitHub, owner: str, name: str, number: int, review_ids: Collection[int]) -> ReviewThreads:
    """The unresolved threads of the pull request with a comment of one of the reviews, from one query.

    Odd entries are left out and never raise. An answer that holds no list of threads at all raises GitHubError:
    a run without the threads it must answer would be worse than a late one.
    """
    answer = github.graphql(QUERY, {"owner": owner, "name": name, "number": number})
    page = _walk(answer, "repository", "pullRequest", "reviewThreads")
    nodes = page.get("nodes") if isinstance(page, dict) else None
    if not isinstance(nodes, list):
        raise GitHubError(0, "the review threads answer has an unexpected shape")
    kept = []
    for node in nodes:
        found = _thread_from(node)
        if found is not None and set(review_ids).intersection(found[1]):
            kept.append(found[0])
    return ReviewThreads(tuple(kept), _has_next_page(page))


def _walk(node: object, *steps: str) -> object:
    for step in steps:
        node = node.get(step) if isinstance(node, dict) else None
    return node


def _has_next_page(page: object) -> bool:
    return _walk(page, "pageInfo", "hasNextPage") is True


def _is_id(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _thread_from(node: object) -> tuple[jobs.Thread, set[int]] | None:
    """An unresolved thread and the ids of the reviews its comments belong to; None when it is odd or resolved.

    Replies attach to the thread's first comment, so a thread whose first comment is odd is left out whole.
    """
    if not isinstance(node, dict):
        return None
    thread_id, path, line, resolved = node.get("id"), node.get("path"), node.get("line"), node.get("isResolved")
    nodes = _walk(node, "comments", "nodes")
    line_fits = line is None or (isinstance(line, int) and not isinstance(line, bool))
    if not (isinstance(thread_id, str) and isinstance(path, str) and isinstance(resolved, bool) and line_fits
            and isinstance(nodes, list) and nodes) or resolved:
        return None
    comments = [_comment_from(entry) for entry in nodes]
    if comments[0] is None:
        return None
    shown = [comment for comment in comments if comment is not None]
    texts = tuple((comment.author, comment.body) for comment in shown)
    reviews = {comment.review for comment in shown if comment.review is not None}
    return jobs.Thread(thread_id, path, line or 0, shown[0].id, texts), reviews


def _comment_from(node: object) -> _Comment | None:
    """A comment, or None when a field is odd; its review is None when it belongs to no review."""
    if not isinstance(node, dict):
        return None
    login, body = _walk(node, "author", "login"), node.get("body")
    review = node.get("pullRequestReview")
    review_id = _walk(review, "databaseId")
    if not (_is_id(node.get("databaseId")) and isinstance(login, str) and isinstance(body, str)
            and (review is None or _is_id(review_id))):
        return None
    return _Comment(node["databaseId"], login, body, review_id)

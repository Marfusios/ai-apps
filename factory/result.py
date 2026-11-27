"""Validation of the result file an agent writes at the end of a run."""

import json
from collections.abc import Iterator, Mapping
from pathlib import Path

STAGES = ("design", "plan", "step", "fix", "revise", "fix_issue")
OUTCOMES = ("done", "needs_input", "failed")
MAX_RESULT_BYTES = 200_000
KEYS = {"schema", "outcome", "summary", "questions", "failure_reason", "pull_request",
        "thread_replies", "verification", "follow_ups"}
MAX_FOLLOW_UPS = 10
MAX_QUESTIONS = 20
MAX_VERIFICATIONS = 30


class ResultError(ValueError):
    """The result file is unreadable or breaks the schema."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def has_visible_character(text: str) -> bool:
    """Whether the text holds a character that is printable and not white space, so that a reader sees something."""
    return any(char.isprintable() and not char.isspace() for char in text)


def _text(value: object, path: str, low: int, high: int, problems: list[str], *, posted: bool = False) -> None:
    """A string within its limits; one the dispatcher posts must also hold a visible character."""
    if not isinstance(value, str) or not low <= len(value) <= high:
        problems.append(f"{path}: must be a string of {low} to {high} characters")
    elif posted and not has_visible_character(value):
        problems.append(f"{path}: must hold a character that is printable and not white space")


def _objects(value: object, path: str, keys: set[str], problems: list[str]) -> list[tuple[int, dict]]:
    """Return the (index, item) pairs of a list of objects with exactly these keys; report anything else."""
    if not isinstance(value, list):
        problems.append(f"{path}: must be a list")
        return []
    items = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or set(item) != keys:
            problems.append(f"{path}[{index}]: must be an object with exactly the keys {sorted(keys)}")
        else:
            items.append((index, item))
    return items


def validate(data: object, stage: str) -> list[str]:
    """Return every problem with a result for this stage; an empty list means valid."""
    if not isinstance(data, dict):
        return ["result: must be a JSON object"]
    problems: list[str] = []
    if stage not in STAGES:
        problems.append(f"stage: '{stage}' is not one of {STAGES}")
    problems.extend(f"{key}: unknown key" for key in data if key not in KEYS)
    if data.get("schema") != 1 or isinstance(data.get("schema"), bool):
        problems.append("schema: must be 1")
    outcome = data.get("outcome")
    if outcome not in OUTCOMES:
        problems.append(f"outcome: must be one of {OUTCOMES}")
    _text(data.get("summary"), "summary", 1, 4000, problems, posted=True)

    questions = data.get("questions")
    if questions is not None and not (isinstance(questions, list) and all(isinstance(q, str) and q for q in questions)):
        problems.append("questions: must be a list of non-empty strings")
    elif outcome == "needs_input" and not questions:
        problems.append("questions: required when outcome is needs_input")
    elif outcome != "needs_input" and questions:
        problems.append("questions: allowed only when outcome is needs_input")
    elif isinstance(questions, list):
        if len(questions) > MAX_QUESTIONS:
            problems.append(f"questions: at most {MAX_QUESTIONS} entries")
        for index, question in enumerate(questions):
            _text(question, f"questions[{index}]", 1, 2000, problems, posted=True)

    reason = data.get("failure_reason")
    if outcome == "failed":
        if not isinstance(reason, str) or not reason.strip():
            problems.append("failure_reason: required when outcome is failed")
        else:
            _text(reason, "failure_reason", 1, 4000, problems, posted=True)
    elif reason is not None:
        problems.append("failure_reason: allowed only when outcome is failed")

    pull_request = data.get("pull_request")
    if pull_request is not None:
        if isinstance(pull_request, dict) and set(pull_request) == {"title", "body"}:
            _text(pull_request["title"], "pull_request.title", 1, 120, problems, posted=True)
            _text(pull_request["body"], "pull_request.body", 1, 20000, problems, posted=True)
        else:
            problems.append("pull_request: must be an object with exactly the keys ['body', 'title']")
    elif outcome == "done" and stage not in ("revise", "fix"):
        problems.append("pull_request: required when outcome is done")

    if "thread_replies" in data:
        if stage != "revise":
            problems.append("thread_replies: allowed only for the revise stage")
        for index, reply in _objects(data["thread_replies"], "thread_replies", {"thread_id", "body", "resolved"}, problems):
            path = f"thread_replies[{index}]"
            _text(reply["thread_id"], f"{path}.thread_id", 1, 200, problems)
            _text(reply["body"], f"{path}.body", 1, 4000, problems)
            if not isinstance(reply["resolved"], bool):
                problems.append(f"{path}.resolved: must be true or false")

    verification = data.get("verification")
    if verification is not None:
        if isinstance(verification, list) and len(verification) > MAX_VERIFICATIONS:
            problems.append(f"verification: at most {MAX_VERIFICATIONS} entries")
        for index, entry in _objects(verification, "verification", {"command", "exit_code", "summary"}, problems):
            path = f"verification[{index}]"
            _text(entry["command"], f"{path}.command", 1, 500, problems)
            if not isinstance(entry["exit_code"], int) or isinstance(entry["exit_code"], bool):
                problems.append(f"{path}.exit_code: must be an integer")
            _text(entry["summary"], f"{path}.summary", 0, 2000, problems)
    if outcome == "done" and not (isinstance(verification, list) and verification):
        problems.append("verification: required and non-empty when outcome is done")

    if "follow_ups" in data:
        follow_ups = data["follow_ups"]
        if isinstance(follow_ups, list) and len(follow_ups) > MAX_FOLLOW_UPS:
            problems.append(f"follow_ups: at most {MAX_FOLLOW_UPS} entries")
        for index, entry in _objects(follow_ups, "follow_ups", {"title", "reason"}, problems):
            _text(entry["title"], f"follow_ups[{index}].title", 1, 120, problems, posted=True)
            _text(entry["reason"], f"follow_ups[{index}].reason", 1, 1000, problems, posted=True)
    return problems


def posted_texts(data: Mapping) -> Iterator[tuple[str, str]]:
    """Each text of a valid result that the dispatcher posts, with its field's name as `validate` names it.

    The verification is never posted, and neither are thread replies, which only the revise stage has and this
    version does not run.
    """
    yield "summary", data["summary"]
    for index, question in enumerate(data.get("questions") or ()):
        yield f"questions[{index}]", question
    if data.get("failure_reason") is not None:
        yield "failure_reason", data["failure_reason"]
    pull_request = data.get("pull_request")
    if pull_request is not None:
        yield "pull_request.title", pull_request["title"]
        yield "pull_request.body", pull_request["body"]
    for index, follow_up in enumerate(data.get("follow_ups") or ()):
        yield f"follow_ups[{index}].title", follow_up["title"]
        yield f"follow_ups[{index}].reason", follow_up["reason"]


def load(path: Path, stage: str) -> dict:
    """Read a result file, rejecting oversized or invalid ones with a ResultError."""
    try:
        size = path.stat().st_size
    except OSError as error:
        raise ResultError([f"result: cannot read: {error}"]) from error
    if size > MAX_RESULT_BYTES:
        raise ResultError([f"result: file is {size} bytes, above the limit of {MAX_RESULT_BYTES}"])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, RecursionError) as error:
        raise ResultError([f"result: cannot read as JSON: {error}"]) from error
    problems = validate(data, stage)
    if problems:
        raise ResultError(problems)
    return data

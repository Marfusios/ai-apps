"""Validation of the result file an agent writes at the end of a run."""

import json
from pathlib import Path

STAGES = ("design", "plan", "step", "fix", "revise", "fix_issue")
OUTCOMES = ("done", "needs_input", "failed")
MAX_RESULT_BYTES = 200_000
KEYS = {"schema", "outcome", "summary", "questions", "failure_reason", "pull_request",
        "thread_replies", "verification", "follow_ups"}
MAX_FOLLOW_UPS = 10


class ResultError(ValueError):
    """The result file is unreadable or breaks the schema."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


def _text(value: object, path: str, low: int, high: int, problems: list[str]) -> None:
    if not isinstance(value, str) or not low <= len(value) <= high:
        problems.append(f"{path}: must be a string of {low} to {high} characters")


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
    _text(data.get("summary"), "summary", 1, 4000, problems)

    questions = data.get("questions")
    if questions is not None and not (isinstance(questions, list) and all(isinstance(q, str) and q for q in questions)):
        problems.append("questions: must be a list of non-empty strings")
    elif outcome == "needs_input" and not questions:
        problems.append("questions: required when outcome is needs_input")
    elif outcome != "needs_input" and questions:
        problems.append("questions: allowed only when outcome is needs_input")

    reason = data.get("failure_reason")
    if outcome == "failed":
        if not isinstance(reason, str) or not reason.strip():
            problems.append("failure_reason: required when outcome is failed")
    elif reason is not None:
        problems.append("failure_reason: allowed only when outcome is failed")

    pull_request = data.get("pull_request")
    if pull_request is not None:
        if isinstance(pull_request, dict) and set(pull_request) == {"title", "body"}:
            _text(pull_request["title"], "pull_request.title", 1, 120, problems)
            _text(pull_request["body"], "pull_request.body", 1, 20000, problems)
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
        for index, entry in _objects(verification, "verification", {"command", "exit_code", "summary"}, problems):
            path = f"verification[{index}]"
            if not isinstance(entry["command"], str):
                problems.append(f"{path}.command: must be a string")
            if not isinstance(entry["exit_code"], int) or isinstance(entry["exit_code"], bool):
                problems.append(f"{path}.exit_code: must be an integer")
            if not isinstance(entry["summary"], str):
                problems.append(f"{path}.summary: must be a string")
    if outcome == "done" and not (isinstance(verification, list) and verification):
        problems.append("verification: required and non-empty when outcome is done")

    if "follow_ups" in data:
        follow_ups = data["follow_ups"]
        if isinstance(follow_ups, list) and len(follow_ups) > MAX_FOLLOW_UPS:
            problems.append(f"follow_ups: at most {MAX_FOLLOW_UPS} entries")
        for index, entry in _objects(follow_ups, "follow_ups", {"title", "reason"}, problems):
            _text(entry["title"], f"follow_ups[{index}].title", 1, 120, problems)
            _text(entry["reason"], f"follow_ups[{index}].reason", 1, 1000, problems)
    return problems


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

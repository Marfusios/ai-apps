"""Compose every text the bot posts: run comments, pull request titles and bodies, and fixed notices.

A run comment is the bot's own lines (a header, fixed lead-ins and headings, one closing line, a hidden
marker) around text written by an agent or taken from a bundle. Each piece of that text is neutralised
once and then placed inside a Markdown container it cannot leave, so it can neither swallow the bot's
lines nor repeat them at the start of a line: a block quote (`> `) for the summary and the failure
reason, a list item with indented continuation lines for questions, problems and follow-ups. A blank line
ends every container. The marker is always the last line. A pull request body starts with the one line
GitHub acts on, `Closes #<issue>`, then the neutralised body (an open code fence is closed) and follow-ups.
"""

import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass

from factory import markers, result, spool, textsafe

OUTCOME_WORDS: Mapping[str, str] = {
    "done": "done",
    "needs_input": "needs input",
    "failed": "failed",
    "timeout": "timed out",
    "crashed": "ended without a result",
    "refused": "not started",
    "rejected": "work not published",
    "usage_limit": "waiting for the usage limit",
}

REASON_WORDS: Mapping[str, str] = {
    "firewall": "the host's confinement check failed, so no agent was started",
    "image": "the agent image is missing or does not match the deployed harness",
    "toolchain": "the app needs a toolchain the agent image does not have",
    "services": "the app declares service containers, which this version does not run",
    "request": "the request for the agent could not be built",
    "clone": "the repository could not be prepared for the agent",
    "max_turns": "the run used all its turns",
    "agent_error": "the agent stopped with an error",
    "internal": "the factory hit an internal error",
}

MAX_COMMENT = 60_000
SUMMARY_LIMIT = 4_000
QUESTION_LIMIT = 2_000
MAX_QUESTIONS = 20
FAILURE_REASON_LIMIT = 4_000
PROBLEM_LIMIT = 300
MAX_PROBLEMS = 21
FOLLOW_UP_TITLE_LIMIT = 120
FOLLOW_UP_REASON_LIMIT = 1_000
MAX_FOLLOW_UPS = 10
TITLE_LIMIT = 120
BODY_LIMIT = 20_000
# The least a shrunk text keeps; a comment that is still too long without it loses the text instead.
SHRUNK_FLOOR = 100
# Room kept for the summary when the questions are shrunk, so a short summary is not the one to go.
SUMMARY_RESERVE = 1_000

OMITTED_SUMMARY = "(The summary was left out to keep this comment within GitHub's size limit.)"

_BRANCH = re.compile(r"factory/[a-z0-9][a-z0-9-]{0,60}")
_RETRY_AT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
_PULL_REQUEST_URL = re.compile(r"https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+")
_MODEL = re.compile(r"[A-Za-z0-9._:\[\]-]{0,100}")
_FENCE = re.compile(r" {0,3}(`{3,}|~{3,})(.*)")

_NOTICES: Mapping[str, tuple[str, str]] = {
    "untrusted-author": (
        "This issue was opened by an account outside the factory's trusted list, so its text is not passed to "
        "the agent. A trusted person can restate the request in a comment here, and the work starts from that "
        "comment.",
        "needs_input",
    ),
    "needs-app": (
        "The factory could not tell which app this issue is about. Reply with a line "
        "`app: <directory name under apps/>`.",
        "needs_input",
    ),
    "pr-closed": (
        "The pull request for this issue was closed without merging. Comment `/factory retry` to run again from "
        "the work branch, or close this issue.",
        "failed",
    ),
}


@dataclass(frozen=True)
class _Pieces:
    """The parts of a comment that do not depend on how much room the shrinkable texts get."""

    header: str
    reason_line: str
    failure_section: str
    problems_section: str
    follow_ups_section: str
    closing: str
    marker: str


def _check(name: str, value: object, pattern: re.Pattern[str], *, optional: bool = False) -> str:
    if optional and value == "":
        return ""
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise ValueError(f"{name} does not have its expected form")
    return value


def _duration(seconds: int) -> str:
    if isinstance(seconds, bool) or not isinstance(seconds, int) or seconds < 0:
        raise ValueError("duration_seconds must be a non-negative integer")
    return "under 1 min" if seconds < 60 else f"{seconds // 60} min"


def _quote(text: str) -> str:
    return "\n".join(f"> {line}" if line else ">" for line in text.split("\n"))


def _item(marker: str, content: str) -> str:
    """A list item whose continuation lines stay inside it, and whose text cannot become a checkbox."""
    first, *rest = content.split("\n")
    if first.startswith("["):
        first = textsafe.ZWSP + first
    indent = " " * len(marker)
    return "\n".join([marker + first, *(indent + line if line.strip() else "" for line in rest)])


def _quoted_section(lead_in: str, text: str, limit: int) -> str:
    cleaned = textsafe.neutralise(text, limit).strip() if text.strip() else ""
    return f"{lead_in}\n\n{_quote(cleaned)}" if cleaned else ""


def _questions_section(questions: Sequence[str], limit: int) -> str:
    texts = [textsafe.neutralise(q, limit).strip() for q in questions[:MAX_QUESTIONS] if q.strip()]
    items = [_item(f"{number}. ", text) for number, text in enumerate(texts, 1) if text]
    return "**Questions from the agent**\n\n" + "\n".join(items) if items else ""


def _problems_section(problems: Sequence[str]) -> str:
    given = [p for p in problems if p.strip()]
    shown = given if len(given) <= MAX_PROBLEMS else given[: MAX_PROBLEMS - 1]
    items = [_item("- ", text) for text in (textsafe.single_line(p, PROBLEM_LIMIT) for p in shown) if text]
    if len(given) > MAX_PROBLEMS:
        items.append(f"- and {len(given) - len(shown)} more")
    return "**Why it was not published**\n\n" + "\n".join(items) if items else ""


def _follow_up_items(follow_ups: Sequence[Mapping[str, str]]) -> list[str]:
    items = []
    for follow_up in follow_ups[:MAX_FOLLOW_UPS]:
        title = textsafe.single_line(follow_up.get("title", ""), FOLLOW_UP_TITLE_LIMIT)
        reason = textsafe.neutralise(follow_up.get("reason", ""), FOLLOW_UP_REASON_LIMIT).strip()
        if title:
            items.append(_item("- ", f"**{title}**: {reason}" if reason else f"**{title}**"))
    return items


def _closing(outcome: str, *, pull_request_url: str, branch: str, kept_commits: int, retry_at: str) -> str:
    if outcome == "needs_input":
        line = "Reply in a comment and the work continues from where it stopped."
        if kept_commits and branch:
            line += f" The work so far is on the branch `{branch}`."
        return line
    if outcome == "done":
        return f"Pull request: {pull_request_url}" if pull_request_url else ""
    if outcome == "usage_limit":
        line = "The subscription's usage limit was reached."
        return f"{line} The run starts again after {retry_at}." if retry_at else f"{line} The run starts again later."
    return "Comment `/factory retry` to run this again."


def _shrink(limit: int, items: int, length: Callable[[int], int]) -> int:
    """The largest limit, down to the floor, at which `length(limit)` fits; each pass removes the whole excess."""
    while limit > SHRUNK_FLOOR:
        excess = length(limit) - MAX_COMMENT
        if excess <= 0:
            break
        limit = max(SHRUNK_FLOOR, limit - math.ceil(excess / items))
    return limit


def run_comment(
    *,
    job_id: str,
    stage: str,
    outcome: str,
    duration_seconds: int,
    model: str,
    summary: str = "",
    questions: Sequence[str] = (),
    failure_reason: str = "",
    problems: Sequence[str] = (),
    follow_ups: Sequence[Mapping[str, str]] = (),
    pull_request_url: str = "",
    branch: str = "",
    kept_commits: int = 0,
    retry_at: str = "",
    reason: str | None = None,
) -> str:
    """The comment after a run, ending with a marker that no other text in it can imitate."""
    if outcome not in OUTCOME_WORDS:
        raise ValueError(f"unknown outcome: {outcome!r}")
    if reason is not None and reason not in REASON_WORDS:
        raise ValueError(f"unknown reason: {reason!r}")
    if stage not in result.STAGES:
        raise ValueError(f"unknown stage: {stage!r}")
    _check("job_id", job_id, spool.JOB_ID)
    _check("model", model, _MODEL)
    _check("branch", branch, _BRANCH, optional=True)
    _check("retry_at", retry_at, _RETRY_AT, optional=True)
    _check("pull_request_url", pull_request_url, _PULL_REQUEST_URL, optional=True)

    marker = {"kind": "run", "job": job_id, "stage": stage, "outcome": outcome}
    if outcome == "usage_limit":
        marker["retry_at"] = retry_at
    pieces = _Pieces(
        header=(f"**Factory run** · stage `{stage}` · **{OUTCOME_WORDS[outcome]}** · {_duration(duration_seconds)}"
                f" · model `{model or 'unknown'}`"),
        reason_line=f"This run ended because {REASON_WORDS[reason]}." if reason is not None else "",
        failure_section=_quoted_section("The agent's reason:", failure_reason, FAILURE_REASON_LIMIT),
        problems_section=_problems_section(problems),
        follow_ups_section=_follow_ups_section(follow_ups),
        closing=_closing(outcome, pull_request_url=pull_request_url, branch=branch, kept_commits=kept_commits,
                         retry_at=retry_at),
        marker=markers.encode(marker),
    )

    def render(summary_section: str, question_limit: int) -> str:
        sections = (pieces.header, summary_section, _questions_section(questions, question_limit),
                    pieces.failure_section, pieces.reason_line, pieces.problems_section, pieces.follow_ups_section,
                    pieces.closing, pieces.marker)
        return "\n\n".join(section for section in sections if section)

    # Everything else keeps its normal limit; the questions take what remains after a reserve for the
    # summary, and the summary takes what is then left.
    question_limit = QUESTION_LIMIT
    if any(q.strip() for q in questions[:MAX_QUESTIONS]):
        question_limit = _shrink(
            QUESTION_LIMIT, len(questions[:MAX_QUESTIONS]), lambda limit: len(render("", limit)) + SUMMARY_RESERVE
        )

    def summary_section(limit: int) -> str:
        return _quoted_section("The agent reports:", summary, limit)

    if not summary_section(SUMMARY_LIMIT):
        return render("", question_limit)
    summary_limit = _shrink(SUMMARY_LIMIT, 1, lambda limit: len(render(summary_section(limit), question_limit)))
    section = summary_section(summary_limit)
    if len(render(section, question_limit)) > MAX_COMMENT:
        section = OMITTED_SUMMARY
    return render(section, question_limit)


def _follow_ups_section(follow_ups: Sequence[Mapping[str, str]]) -> str:
    items = _follow_up_items(follow_ups)
    return "**Follow-ups the agent noticed**\n\n" + "\n".join(items) if items else ""


def pull_request_title(title: str) -> str:
    """One neutral line of at most 120 characters."""
    return textsafe.single_line(title, TITLE_LIMIT)


def _close_open_fence(text: str) -> str:
    """The text, with a closing line added when a code fence is still open at its end."""
    open_fence = ""
    for line in text.split("\n"):
        match = _FENCE.fullmatch(line)
        if not match:
            continue
        run, rest = match.groups()
        if not open_fence:
            if run[0] != "`" or "`" not in rest:
                open_fence = run
        elif run[0] == open_fence[0] and len(run) >= len(open_fence) and not rest.strip():
            open_fence = ""
    return f"{text}\n{open_fence}" if open_fence else text


def pull_request_body(body: str, issue_number: int, follow_ups: Sequence[Mapping[str, str]]) -> str:
    """`Closes #<issue>` first, then the neutralised body and follow-ups; no other reference can act."""
    if isinstance(issue_number, bool) or not isinstance(issue_number, int) or issue_number < 1:
        raise ValueError("issue_number must be a positive integer")
    parts = [f"Closes #{issue_number}"]
    body_text = textsafe.neutralise(body, BODY_LIMIT).strip()
    if body_text:
        parts.append(_close_open_fence(body_text))
    items = _follow_up_items(follow_ups)
    if items:
        parts.append("## Follow-ups\n\n" + "\n".join(items))
    return "\n\n".join(parts)


def notice(key: str) -> str:
    """A fixed comment, with no parameter that could carry text from an issue or a stranger."""
    if key not in _NOTICES:
        raise ValueError(f"unknown notice: {key!r}")
    text, outcome = _NOTICES[key]
    return f"{text}\n\n{markers.encode({'kind': 'notice', 'key': key, 'outcome': outcome})}"

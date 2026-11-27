"""Compose every text the bot posts: run comments, pull request titles and bodies, and fixed notices."""

import math
from collections.abc import Mapping, Sequence

from factory import markers, textsafe

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
MAX_PROBLEM_LINES = 20
FOLLOW_UP_TITLE_LIMIT = 120
FOLLOW_UP_REASON_LIMIT = 1_000
MAX_FOLLOW_UPS = 10
TITLE_LIMIT = 120
BODY_LIMIT = 20_000
# The shortest limit `neutralise` accepts: only its truncation mark fits.
MIN_TEXT_LIMIT = 13

_FAILURE_OUTCOMES = ("failed", "timeout", "crashed", "refused", "rejected")

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


def _inline(text: str, limit: int) -> str:
    """One neutral line safe inside a code span: a backtick would end the span early."""
    return textsafe.single_line(text, limit).replace("`", "'")


def _duration(seconds: int) -> str:
    if isinstance(seconds, bool) or not isinstance(seconds, int) or seconds < 0:
        raise ValueError("duration_seconds must be a non-negative integer")
    return "under 1 min" if seconds < 60 else f"{seconds // 60} min"


def _follow_up_lines(follow_ups: Sequence[Mapping[str, str]]) -> list[str]:
    lines = []
    for follow_up in follow_ups[:MAX_FOLLOW_UPS]:
        title = textsafe.single_line(follow_up.get("title", ""), FOLLOW_UP_TITLE_LIMIT)
        reason = textsafe.neutralise(follow_up.get("reason", ""), FOLLOW_UP_REASON_LIMIT).strip()
        if title:
            lines.append(f"- **{title}**: {reason}" if reason else f"- **{title}**")
    return lines


def _closing(outcome: str, *, pull_request_url: str, branch: str, kept_commits: int, retry_at: str) -> str:
    """`retry_at` arrives already neutralised."""
    if outcome == "needs_input":
        line = "Reply in a comment and the work continues from where it stopped."
        if kept_commits and branch:
            line += f" The work so far is on the branch `{_inline(branch, 100)}`."
        return line
    if outcome == "done":
        url = textsafe.single_line(pull_request_url, 300)
        return f"Pull request: {url}" if url else ""
    if outcome == "usage_limit":
        line = "The subscription's usage limit was reached."
        return f"{line} The run starts again after {retry_at}." if retry_at else f"{line} The run starts again later."
    return "Comment `/factory retry` to run this again."


def _assemble(
    *, job_id, stage, outcome, duration_seconds, model, summary, summary_limit, questions, question_limit,
    failure_reason, problems, follow_ups, pull_request_url, branch, kept_commits, retry_at, reason,
) -> str:
    header = f"**Factory run** · stage `{stage}` · **{OUTCOME_WORDS[outcome]}** · {_duration(duration_seconds)}"
    model_name = _inline(model, 100)
    if model_name:
        header += f" · model `{model_name}`"
    parts = [header]

    summary_text = textsafe.neutralise(summary, summary_limit).strip() if summary_limit else ""
    if summary_text:
        parts.append(summary_text)

    question_texts = [textsafe.neutralise(q, question_limit).strip() for q in questions[:MAX_QUESTIONS] if q.strip()]
    question_texts = [q for q in question_texts if q]
    if question_texts:
        parts.append("**Questions**\n\n" + "\n".join(f"{n}. {q}" for n, q in enumerate(question_texts, 1)))

    failure_text = textsafe.neutralise(failure_reason, FAILURE_REASON_LIMIT).strip()
    if failure_text:
        parts.append(f"**What went wrong**\n\n{failure_text}")
    if reason is not None:
        parts.append(f"This run ended because {REASON_WORDS[reason]}.")

    problem_texts = [textsafe.single_line(p, PROBLEM_LIMIT) for p in problems if p.strip()]
    problem_texts = [p for p in problem_texts if p]
    if problem_texts:
        lines = [f"- {p}" for p in problem_texts[:MAX_PROBLEM_LINES]]
        if len(problem_texts) > MAX_PROBLEM_LINES:
            lines.append(f"- and {len(problem_texts) - MAX_PROBLEM_LINES} more")
        parts.append("**Why it was not published**\n\n" + "\n".join(lines))

    follow_up_lines = _follow_up_lines(follow_ups)
    if follow_up_lines:
        parts.append("**Follow-ups noticed**\n\n" + "\n".join(follow_up_lines))

    retry_text = textsafe.single_line(retry_at, 40)
    closing = _closing(
        outcome, pull_request_url=pull_request_url, branch=branch, kept_commits=kept_commits, retry_at=retry_text
    )
    if closing:
        parts.append(closing)

    marker = {"kind": "run", "job": job_id, "stage": stage, "outcome": outcome}
    if outcome == "usage_limit":
        marker["retry_at"] = retry_text
    parts.append(markers.encode(marker))
    return "\n\n".join(parts)


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

    fields = dict(
        job_id=job_id, stage=stage, outcome=outcome, duration_seconds=duration_seconds, model=model,
        summary=summary, questions=questions, failure_reason=failure_reason, problems=problems,
        follow_ups=follow_ups, pull_request_url=pull_request_url, branch=branch, kept_commits=kept_commits,
        retry_at=retry_at, reason=reason,
    )
    summary_limit, question_limit = SUMMARY_LIMIT, QUESTION_LIMIT
    comment = _assemble(summary_limit=summary_limit, question_limit=question_limit, **fields)
    # Shrink the summary first; only when it is gone, shrink the questions, so the marker is never cut.
    while len(comment) > MAX_COMMENT:
        excess = len(comment) - MAX_COMMENT
        if summary_limit:
            summary_limit = summary_limit - excess if summary_limit - excess >= MIN_TEXT_LIMIT else 0
        elif question_limit > MIN_TEXT_LIMIT:
            cut = math.ceil(excess / max(1, len(questions[:MAX_QUESTIONS])))
            question_limit = max(MIN_TEXT_LIMIT, question_limit - cut)
        else:
            raise ValueError("the comment cannot be made to fit")
        comment = _assemble(summary_limit=summary_limit, question_limit=question_limit, **fields)
    return comment


def pull_request_title(title: str) -> str:
    """One neutral line of at most 120 characters."""
    return textsafe.single_line(title, TITLE_LIMIT)


def pull_request_body(body: str, issue_number: int, follow_ups: Sequence[Mapping[str, str]]) -> str:
    """The neutralised body and follow-ups, then the only reference GitHub can act on: `Closes #<issue>`."""
    if isinstance(issue_number, bool) or not isinstance(issue_number, int) or issue_number < 1:
        raise ValueError("issue_number must be a positive integer")
    parts = []
    body_text = textsafe.neutralise(body, BODY_LIMIT).strip()
    if body_text:
        parts.append(body_text)
    follow_up_lines = _follow_up_lines(follow_ups)
    if follow_up_lines:
        parts.append("## Follow-ups\n\n" + "\n".join(follow_up_lines))
    parts.append(f"Closes #{issue_number}")
    return "\n\n".join(parts)


def notice(key: str) -> str:
    """A fixed comment, with no parameter that could carry text from an issue or a stranger."""
    if key not in _NOTICES:
        raise ValueError(f"unknown notice: {key!r}")
    text, outcome = _NOTICES[key]
    return f"{text}\n\n{markers.encode({'kind': 'notice', 'key': key, 'outcome': outcome})}"

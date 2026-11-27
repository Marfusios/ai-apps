"""Compose every text the bot posts: run comments, pull request titles and bodies, and fixed notices.

A run comment is the bot's own lines (a header, fixed lead-ins and headings, one closing line, a hidden
marker) around text written by an agent or taken from a bundle. Each piece of that text is neutralised
once and then placed inside a Markdown container it cannot leave, so it can neither swallow the bot's
lines nor repeat them at the start of a line: a block quote (`> `) for the summary and the failure
reason, a list item with indented continuation lines for questions, problems and follow-ups. A blank line
ends every container. The marker is always the last line. When the comment is over GitHub's size limit,
the already-neutralised questions are cut evenly, then the summary, then the failure reason, each at most
once. A pull request body starts with the one line GitHub acts on, `Closes #<issue>`.
"""

import re
from collections.abc import Callable, Mapping, Sequence

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
FALLBACK_TITLE = "Change from the factory"  # GitHub refuses a pull request without a title
BODY_LIMIT = 20_000
# The least of a text that a cut keeps; a summary that cannot keep it is replaced by a fixed line.
CUT_FLOOR = 100
CUT_MARK = "\n\n(truncated)"

OMITTED_SUMMARY = "(The summary was left out to keep this comment within GitHub's size limit.)"

PULL_REQUEST_URL = re.compile(r"https://github\.com/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+/pull/[0-9]+")
_BRANCH = re.compile(r"factory/[a-z0-9][a-z0-9-]{0,60}")
_RETRY_AT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z")
MODEL = re.compile(r"[A-Za-z0-9._:\[\]-]{0,100}")

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


def _neutral(text: str, limit: int) -> str:
    """The text neutralised and stripped; empty when nothing but whitespace was given."""
    return textsafe.neutralise(text, limit).strip() if text.strip() else ""


def _quote(text: str) -> str:
    return "\n".join(f"> {line}" if line else ">" for line in text.split("\n"))


def _item(marker: str, content: str) -> str:
    """A list item whose continuation lines stay inside it; the neutralised text holds no checkbox to start it."""
    first, *rest = content.split("\n")
    indent = " " * len(marker)
    return "\n".join([marker + first, *(indent + line if line.strip() else "" for line in rest)])


def _quoted_section(lead_in: str, text: str) -> str:
    return f"{lead_in}\n\n{_quote(text)}" if text else ""


def _questions_section(items: Sequence[str]) -> str:
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


def _follow_ups_section(follow_ups: Sequence[Mapping[str, str]]) -> str:
    items = _follow_up_items(follow_ups)
    return "**Follow-ups the agent noticed**\n\n" + "\n".join(items) if items else ""


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


def _cut(text: str, render: Callable[[str], str], budget: int) -> str | None:
    """The longest prefix of the neutralised text, plus the cut mark, whose rendering fits `budget`.

    None when the text is too short to cut or even `CUT_FLOOR` characters of it do not fit. Rendering
    only adds characters per character cut away, so the result is at least as small as asked.
    """
    if len(text) <= CUT_FLOOR or len(render(text[:CUT_FLOOR] + CUT_MARK)) > budget:
        return None
    low, high = CUT_FLOOR, len(text) - 1
    while low < high:
        middle = (low + high + 1) // 2
        if len(render(text[:middle] + CUT_MARK)) <= budget:
            low = middle
        else:
            high = middle - 1
    return text[:low] + CUT_MARK


def _cut_questions(texts: list[str], excess: int) -> None:
    """Cut the longest questions down to a common rendered size so that `excess` characters go; none below the floor."""
    def rendered(number: int, text: str) -> str:
        return _item(f"{number}. ", text)

    sizes = [len(rendered(n, text)) for n, text in enumerate(texts, 1)]
    floors = [
        min(size, len(rendered(n, text[:CUT_FLOOR] + CUT_MARK))) if len(text) > CUT_FLOOR else size
        for n, (text, size) in enumerate(zip(texts, sizes), 1)
    ]

    def removed(level: int) -> int:
        return sum(size - max(level, floor) for size, floor in zip(sizes, floors) if size > max(level, floor))

    low, high = 0, max(sizes)
    while low < high:  # the largest level that still removes enough
        middle = (low + high + 1) // 2
        if removed(middle) >= excess:
            low = middle
        else:
            high = middle - 1
    for number, (text, size, floor) in enumerate(zip(texts, sizes, floors), 1):
        if size > max(low, floor):
            cut = _cut(text, lambda candidate, n=number: rendered(n, candidate), low)
            texts[number - 1] = cut if cut is not None else text[:CUT_FLOOR] + CUT_MARK


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
    _check("model", model, MODEL)
    _check("branch", branch, _BRANCH, optional=True)
    _check("retry_at", retry_at, _RETRY_AT, optional=True)
    _check("pull_request_url", pull_request_url, PULL_REQUEST_URL, optional=True)

    marker = {"kind": "run", "job": job_id, "stage": stage, "outcome": outcome}
    if outcome == "usage_limit":
        marker["retry_at"] = retry_at
    header = (f"**Factory run** · stage `{stage}` · **{OUTCOME_WORDS[outcome]}** · {_duration(duration_seconds)}"
              f" · model `{model or 'unknown'}`")
    reason_line = f"This run ended because {REASON_WORDS[reason]}." if reason is not None else ""
    problems_section = _problems_section(problems)
    follow_ups_section = _follow_ups_section(follow_ups)
    closing = _closing(outcome, pull_request_url=pull_request_url, branch=branch, kept_commits=kept_commits,
                       retry_at=retry_at)

    # Each text is neutralised here, once; later cuts only shorten these strings.
    summary_text = _neutral(summary, SUMMARY_LIMIT)
    failure_text = _neutral(failure_reason, FAILURE_REASON_LIMIT)
    question_texts = [t for t in (_neutral(q, QUESTION_LIMIT) for q in questions[:MAX_QUESTIONS]) if t]

    def summary_render(text: str) -> str:
        return _quoted_section("The agent reports:", text)

    def failure_render(text: str) -> str:
        return _quoted_section("The agent's reason:", text)

    def render(summary_section: str) -> str:
        items = [_item(f"{n}. ", text) for n, text in enumerate(question_texts, 1)]
        sections = (header, summary_section, _questions_section(items), failure_render(failure_text), reason_line,
                    problems_section, follow_ups_section, closing, markers.encode(marker))
        return "\n\n".join(section for section in sections if section)

    summary_section = summary_render(summary_text)
    excess = len(render(summary_section)) - MAX_COMMENT
    if excess > 0 and question_texts:
        _cut_questions(question_texts, excess)
        excess = len(render(summary_section)) - MAX_COMMENT
    if excess > 0 and summary_text:
        cut = _cut(summary_text, summary_render, len(summary_section) - excess)
        if cut is not None:
            summary_section = summary_render(cut)
        elif len(OMITTED_SUMMARY) < len(summary_section):
            summary_section = OMITTED_SUMMARY
        excess = len(render(summary_section)) - MAX_COMMENT
    if excess > 0 and failure_text:
        before = len(failure_render(failure_text))
        cut = _cut(failure_text, failure_render, before - excess)
        if cut is None and len(failure_text) > CUT_FLOOR:
            cut = failure_text[:CUT_FLOOR] + CUT_MARK
        if cut is not None and len(failure_render(cut)) < before:
            failure_text = cut
    return render(summary_section)


def pull_request_title(title: str) -> str:
    """One neutral line of at most 120 characters, or a fixed title when nothing printable is left of it."""
    line = textsafe.single_line(title, TITLE_LIMIT)
    return line if result.has_visible_character(line) else FALLBACK_TITLE


def pull_request_body(body: str, issue_number: int, follow_ups: Sequence[Mapping[str, str]]) -> str:
    """`Closes #<issue>` first, then the neutralised body and the follow-ups; no other reference can act.

    Nothing is inserted between the body and the follow-ups: an agent body that leaves a code fence open
    hides only its own follow-ups here, and they are also listed in the run comment.
    """
    if isinstance(issue_number, bool) or not isinstance(issue_number, int) or issue_number < 1:
        raise ValueError("issue_number must be a positive integer")
    parts = [f"Closes #{issue_number}"]
    body_text = _neutral(body, BODY_LIMIT)
    if body_text:
        parts.append(body_text)
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

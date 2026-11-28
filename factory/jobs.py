"""The job files of a run: the text the agent may read, its job description and the runner's request."""

import re
from collections.abc import Sequence
from dataclasses import dataclass

from factory import markers
from factory.config import MODEL, PERMISSION_MODES, STAGE_LIMITS, Config, is_trusted
from factory.snapshot import Bot, Comment, Issue
from factory.spool import COMMIT_SHA, JOB_ID, MAX_ROUND, STAMP, THREAD_ID

SKILLS = {"fix_issue": "factory-fix-issue", "fix": "factory-fix", "revise": "factory-revise"}
MAX_CONTEXT_CHARS = 150_000
MAX_ITEM_CHARS = 20_000
MAX_TITLE_CHARS = 300
MAX_LOG_CHARS = 20_000
MAX_FAILED_CHECKS = 5
MAX_NAME_CHARS = 100
MAX_PATH_CHARS = 150  # with the longest id the heading still fits the title limit `_section` applies
MAX_LINE = 10_000_000
# The least of a section that cutting it down to share the room keeps; below it a comment is dropped instead.
SECTION_FLOOR = 1_000
CUT_LINE = "(truncated)"
MAX_PULL_REQUEST = 2**53  # the largest integer every JSON reader keeps exact
# What a hosted check's log carries that tells an agent nothing: the time before each line, colour and cursor
# sequences, and control characters (a NUL among them makes tools read the whole context as a binary file).
_LOG_TIME = re.compile(r"(?m)^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]+Z ")
_LOG_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")
_LOG_CONTROL = re.compile(r"[\x00-\x08\x0b-\x1f\x7f]")
WITHHELD_TITLE = "(title withheld)"
WITHHELD_BODY = "The issue was opened by someone outside the trusted list, so its text is not included."
APP_LINE = re.compile(r"(?i:app):\s*([a-z0-9][a-z0-9-]*)\s*")
APP_VALUE = re.compile(r"[a-z0-9][a-z0-9-]*")
APP_HEADING = "### App"
RETRY_COMMAND = "/factory retry"
REVISE_COMMAND = "/factory revise"
APP = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")
BRANCH = re.compile(r"factory/[a-z0-9][a-z0-9-]{0,60}")
# A component made only of dots would turn the URL into a path that climbs out of github.com/<owner>.
REPOSITORY_URL = re.compile(r"https://github\.com/(?!\.+/)[A-Za-z0-9._-]+/(?!\.+\.git)[A-Za-z0-9._-]+\.git")
MAX_IDENTITY_CHARS = 200
REQUEST_KEYS = (
    "schema", "job_id", "stage", "skill", "app", "branch", "base_sha", "repository_url", "model",
    "permission_mode", "timeout_minutes", "max_turns", "git_name", "git_email", "round", "pull_request",
)


@dataclass(frozen=True)
class Thread:
    """A review thread on a pull request: where it hangs and the (author, body) of each comment."""

    id: str
    path: str
    line: int
    first_comment_id: int
    comments: tuple[tuple[str, str], ...]


def is_retry(comment: Comment) -> bool:
    """True when the first non-blank line of the comment is the retry command."""
    for line in comment.body.splitlines():
        if line.strip():
            return line.strip().lower() == RETRY_COMMAND
    return False


def is_revise(comment: Comment) -> str | None:
    """The instruction of a comment whose first non-blank line starts with `/factory revise`, None for any other.

    The instruction is everything after the command: the rest of that line and the lines below it, "" when none.
    """
    lines = comment.body.splitlines()
    for index, line in enumerate(lines):
        text = line.strip()
        if text:
            if not text.lower().startswith(REVISE_COMMAND):
                return None
            rest = text[len(REVISE_COMMAND):]
            if rest and not rest[0].isspace():
                return None
            return "\n".join([rest.strip(), *lines[index + 1:]]).strip()
    return None


def _is_bot(comment: Comment, bot: Bot) -> bool:
    return bool(bot.login) and bot.user_id > 0 and comment.author == bot.login and comment.author_id == bot.user_id


def _last_app_line(text: str) -> str | None:
    found = None
    for line in text.splitlines():
        match = APP_LINE.fullmatch(line)
        if match:
            found = match.group(1)
    return found


def _app_of_comments(issue: Issue, config: Config) -> str | None:
    for comment in reversed(issue.comments):
        name = _last_app_line(comment.body) if is_trusted(comment.author, config) else None
        if name is not None:
            return name
    return None


def _app_of_form(body: str) -> str | None:
    lines = body.splitlines()
    for index, line in enumerate(lines):
        if line.strip() == APP_HEADING:
            for value in lines[index + 1:]:
                if value.strip():
                    return value.strip() if APP_VALUE.fullmatch(value.strip()) else None
    return None


def _usable(name: str | None, apps: Sequence[str]) -> bool:
    """An app that exists and has a name `validate_request` accepts; a directory named otherwise is never chosen."""
    return name is not None and APP.fullmatch(name) is not None and name in apps


def choose_app(issue: Issue, apps: Sequence[str], config: Config) -> str | None:
    """The app a run works on, or None when the dispatcher has to ask.

    The last trusted `app:` line decides alone: naming an unknown app is a typo to ask about, not a reason to
    guess. Only without such a line do the issue form and then the only app apply. Each step returns only a name
    that fully matches APP.
    """
    named = _app_of_comments(issue, config)
    if named is not None:
        return named if _usable(named, apps) else None
    form = _app_of_form(issue.body) if is_trusted(issue.author, config) else None
    if _usable(form, apps):
        return form
    return apps[0] if len(apps) == 1 and _usable(apps[0], apps) else None


def _cut(text: str) -> str:
    if len(text) <= MAX_ITEM_CHARS:
        return text
    return f"{text[:MAX_ITEM_CHARS]}\n\n(This text was cut after {MAX_ITEM_CHARS} characters.)"


def _title(issue: Issue, config: Config) -> str:
    if not is_trusted(issue.author, config):
        return WITHHELD_TITLE
    return " ".join(issue.title.split())[:MAX_TITLE_CHARS]


def _quoted(text: str) -> str:
    """Every line of the text as a Markdown quote; `str.splitlines` also ends a line where a reader might."""
    return "\n".join(f"> {line}" if line else ">" for line in text.splitlines())


def _comment_block(comment: Comment, config: Config, bot: Bot) -> str | None:
    """The comment as a Markdown section, "" when it has no text, None when it is not the agent's to read.

    The factory's comments quote what an agent wrote, so their text is quoted line by line: nothing an earlier run
    wrote can read as a heading, such as the one above a trusted person's comment.
    """
    if _is_bot(comment, bot):
        body = comment.body.split(markers.PREFIX, 1)[0].rstrip()
        return f"### The factory at {comment.created_at}\n\n{_quoted(_cut(body))}" if body.strip() else ""
    if comment.author != bot.login and is_trusted(comment.author, config):
        body = comment.body
        return f"### {comment.author} at {comment.created_at}\n\n{_cut(body)}" if body.strip() else ""
    return None


def _one_line(text: str, limit: int) -> str:
    """The text on one line of printable characters, cut to `limit`: a heading built from it cannot end early."""
    return "".join(char for char in " ".join(text.split()) if char.isprintable())[:limit]


def _section(heading: str, text: str) -> str:
    return f"## {_one_line(heading, MAX_TITLE_CHARS)}\n\n{_quoted(text)}"


def _cut_section(heading: str, text: str, size: int) -> str:
    """The section with the longest start of the text whose rendering, with the cut line, is at most `size`."""
    def render(length: int) -> str:
        start = text[:length].rstrip("\n")
        return _section(heading, f"{start}\n{CUT_LINE}" if start else CUT_LINE)

    low, high = 0, len(text)
    while low < high:
        middle = (low + high + 1) // 2
        if len(render(middle)) <= size:
            low = middle
        else:
            high = middle - 1
    return render(low)


def _fit_sections(sections: Sequence[tuple[str, str]], rendered: list[str], room: int) -> list[str] | None:
    """The sections in `room` characters, the longest cut first to an equal share; None below the floor."""
    if not sections:
        return [] if room >= 0 else None
    sizes = [len(text) for text in rendered]
    if sum(sizes) <= room:
        return rendered
    low, high = 0, max(sizes)
    while low < high:  # the largest share that still fits
        middle = (low + high + 1) // 2
        if sum(min(size, middle) for size in sizes) <= room:
            low = middle
        else:
            high = middle - 1
    if low < SECTION_FLOOR:
        return None
    return [
        _cut_section(heading, text, low) if size > low else whole
        for (heading, text), whole, size in zip(sections, rendered, sizes)
    ]


def _leave_out_sections(rendered: list[str], room: int) -> list[str]:
    """As many whole sections from the start as fit, then a line saying how many are left out."""
    def line(kept: int) -> str:
        return f"Sections left out to keep this text short: {len(rendered) - kept}."

    kept = len(rendered)
    while kept and sum(len(text) + 2 for text in rendered[:kept]) + len(line(kept)) + 2 > room:
        kept -= 1
    return [*rendered[:kept], line(kept)]


def context(issue: Issue, config: Config, bot: Bot, *, sections: Sequence[tuple[str, str]] = ()) -> str:
    """The Markdown the agent reads: only text from trusted people and the factory itself.

    Each `(heading, text)` of `sections` follows the comments as `## <heading>` and the text quoted line by line.
    To stay within `MAX_CONTEXT_CHARS` the sections are cut first, the longest down to an equal share (each keeps
    at least `SECTION_FLOOR` characters), and only then are older comments dropped. With more sections than fit at
    the floor, the later sections are left out and counted.
    """
    trusted = is_trusted(issue.author, config)
    body = _cut(issue.body) if trusted else WITHHELD_BODY
    head = [f"# Issue #{issue.number}: {_title(issue, config)}"] + ([body] if body.strip() else [])
    blocks = []
    dropped = 0
    for comment in issue.comments:
        block = _comment_block(comment, config, bot)
        if block is None:
            dropped += 1
        elif block:
            blocks.append(block)
    tail = [f"Comments by others, not included: {dropped}."] if dropped else []

    def build(left_out: int, quoted: Sequence[str] = ()) -> str:
        note = [f"Older comments left out to keep this text short: {left_out}."] if left_out else []
        return "\n\n".join([*head, "## Comments", *note, *blocks[left_out:], *tail, *quoted]) + "\n"

    rendered = [_section(heading, text) for heading, text in sections]
    for left_out in range(len(blocks) + 1):
        room = MAX_CONTEXT_CHARS - len(build(left_out)) - 2 * len(rendered)  # the blank line before each section
        fitted = _fit_sections(sections, rendered, room)
        if fitted is not None:
            return build(left_out, fitted)
    return build(len(blocks), _leave_out_sections(rendered, room + 2 * len(rendered)) if rendered else [])


def _failed_check_name(name: str) -> str:
    return _one_line(name, MAX_NAME_CHARS) or "(unnamed)"


def _plain_log(log: str) -> str:
    """The log as plain lines, so that the characters kept from its end are the failure and not its decoration."""
    lines = _LOG_ESCAPE.sub("", log).replace("\r\n", "\n").replace("\r", "\n")
    return _LOG_CONTROL.sub("", _LOG_TIME.sub("", lines))


def fix_sections(logs: Sequence[tuple[str, str]], review_text: str) -> list[tuple[str, str]]:
    """The sections of a `fix` run's context: the end of each failed check's log, then the automated review.

    A log loses its line times, colour sequences and control characters before it is cut. At most
    `MAX_FAILED_CHECKS` checks are shown; a last section says how many were left out and by name.
    """
    sections = []
    for name, log in logs[:MAX_FAILED_CHECKS]:
        tail = _plain_log(log)[-MAX_LOG_CHARS:]
        sections.append((f"Failed check: {_failed_check_name(name)}", tail if tail.strip() else "(the log is empty)"))
    left_out = logs[MAX_FAILED_CHECKS:]
    if left_out:
        names = ", ".join(_failed_check_name(name) for name, _ in left_out)
        sections.append(("Failed checks not shown", f"{len(left_out)} more failed checks were left out: {names}"))
    if review_text.strip():
        sections.append(("Automated review", review_text))
    return sections


def _thread_heading(thread: Thread) -> str:
    path = _one_line(thread.path, MAX_PATH_CHARS) or "(no path)"
    line = thread.line if _integer_in(thread.line, 1, MAX_LINE) else 0
    return f"Review thread {thread.id} ({path}:{line})" if line else f"Review thread {thread.id} ({path})"


def _shown_text(thread: Thread, config: Config) -> str:
    """What the agent may read of a thread: the comments of trusted people; "" when it is not shown at all.

    A thread whose id is not an identifier is not shown either: it comes from an API and goes into a heading.
    """
    if not THREAD_ID.fullmatch(thread.id):
        return ""
    text = "\n\n".join(f"{author}:\n{body}" for author, body in thread.comments if is_trusted(author, config))
    return text if text.strip() else ""


def _review_heading(time: str) -> str:
    return f"Review ({time})" if STAMP.fullmatch(time) else "Review"


def revise_sections(
    reviews: Sequence[tuple[str, str]], threads: Sequence[Thread], instruction: str, config: Config
) -> list[tuple[str, str]]:
    """The sections of a `revise` run's context: the instruction, the reviews (oldest first) and their threads.

    The instruction comes first, as the person's directive, so that it is the last to be left out. A review is
    `(submitted time, body)`; the time is shown only when it is exactly `YYYY-MM-DDTHH:MM:SSZ`. A thread is shown
    only as `thread_index` says.
    """
    sections = [("Instruction", instruction)] if instruction.strip() else []
    sections += [(_review_heading(time), body) for time, body in reviews if body.strip()]
    for thread in threads:
        text = _shown_text(thread, config)
        if text:
            sections.append((_thread_heading(thread), text))
    return sections


def thread_index(threads: Sequence[Thread], config: Config) -> dict[str, int]:
    """`{thread id: first comment id}` for the threads `revise_sections` shows: what `threads.json` holds."""
    return {thread.id: thread.first_comment_id for thread in threads if _shown_text(thread, config)}


def job_file(
    *, stage: str, app: str, issue: Issue, branch: str, base_sha: str, config: Config, round: int = 0
) -> dict:
    """The `job.json` the agent contract promises."""
    return {
        "schema": 1,
        "stage": stage,
        "app": app,
        "issue": {"number": issue.number, "title": _title(issue, config)},
        "epic": None,
        "step_id": None,
        "branch": branch,
        "base_sha": base_sha,
        "round": round,
    }


def request_file(
    *, job_id: str, stage: str, app: str, branch: str, base_sha: str, repository: str, config: Config, bot: Bot,
    round: int = 0, pull_request: int = 0,
) -> dict:
    """The `request.json` the runner reads to start the container.

    The dispatcher and the runner are deployed together, so requests without `round` and `pull_request` are refused.
    """
    settings = config.stages[stage]
    return {
        "schema": 1,
        "job_id": job_id,
        "stage": stage,
        "skill": SKILLS[stage],
        "app": app,
        "branch": branch,
        "base_sha": base_sha,
        "repository_url": f"https://github.com/{repository}.git",
        "model": settings.model,
        "permission_mode": config.agent.permission_mode,
        "timeout_minutes": settings.timeout_minutes,
        "max_turns": settings.max_turns,
        "git_name": bot.login,
        "git_email": bot.email,
        "round": round,
        "pull_request": pull_request,
    }


def _matches(pattern: re.Pattern[str], value: object) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _identity(value: object) -> bool:
    """A git name or email: printable (so no NUL or line break), not blank, not an option for `git config`."""
    return (
        isinstance(value, str) and value.isprintable() and bool(value.strip()) and not value.startswith("-")
        and len(value) <= MAX_IDENTITY_CHARS
    )


def _skill_fits(stage: object, skill: object) -> bool:
    """The skill of a known stage; for an unknown stage, still some skill the factory has."""
    if isinstance(stage, str) and stage in SKILLS:
        return skill == SKILLS[stage]
    return isinstance(skill, str) and skill in SKILLS.values()


def _integer_in(value: object, low: int, high: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def validate_request(data: object) -> list[str]:
    """Every way `data` differs from what `request_file` builds; empty when it is acceptable."""
    if not isinstance(data, dict):
        return ["the request must be an object"]
    problems = [f"{key} is required" for key in REQUEST_KEYS if key not in data]
    problems += [f"{key!r} is not a known key" for key in sorted(map(str, set(data) - set(REQUEST_KEYS)))]
    stage = data.get("stage")
    checks = {
        "schema": isinstance(data.get("schema"), int) and not isinstance(data.get("schema"), bool) and data["schema"] == 1,
        "job_id": _matches(JOB_ID, data.get("job_id")),
        "stage": isinstance(stage, str) and stage in SKILLS,
        "skill": _skill_fits(stage, data.get("skill")),
        "app": _matches(APP, data.get("app")),
        "branch": _matches(BRANCH, data.get("branch")),
        "base_sha": _matches(COMMIT_SHA, data.get("base_sha")),
        "repository_url": _matches(REPOSITORY_URL, data.get("repository_url")),
        "model": _matches(MODEL, data.get("model")),
        "permission_mode": data.get("permission_mode") in PERMISSION_MODES,
        "timeout_minutes": _integer_in(data.get("timeout_minutes"), *STAGE_LIMITS["timeout_minutes"]),
        "max_turns": _integer_in(data.get("max_turns"), *STAGE_LIMITS["max_turns"]),
        "git_name": _identity(data.get("git_name")),
        "git_email": _identity(data.get("git_email")),
        "round": _integer_in(data.get("round"), 0, MAX_ROUND),
        "pull_request": _integer_in(data.get("pull_request"), 0, MAX_PULL_REQUEST),
    }
    problems += [f"{key} is not acceptable" for key in REQUEST_KEYS if key in data and not checks[key]]
    return problems

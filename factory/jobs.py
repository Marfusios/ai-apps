"""The job files of a run: the text the agent may read, its job description and the runner's request."""

import re
from collections.abc import Sequence

from factory.config import MODEL, PERMISSION_MODES, STAGE_LIMITS, Config, is_trusted
from factory.snapshot import Bot, Comment, Issue
from factory.spool import JOB_ID

SKILLS = {"fix_issue": "factory-fix-issue"}
MAX_CONTEXT_CHARS = 150_000
MAX_ITEM_CHARS = 20_000
MAX_TITLE_CHARS = 300
WITHHELD_TITLE = "(title withheld)"
WITHHELD_BODY = "The issue was opened by someone outside the trusted list, so its text is not included."
BOT_MARKER_START = "<!-- factory:v1"
APP_LINE = re.compile(r"(?i:app):\s*([a-z0-9][a-z0-9-]*)\s*")
APP_VALUE = re.compile(r"[a-z0-9][a-z0-9-]*")
APP_HEADING = "### App"
RETRY_COMMAND = "/factory retry"
APP = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*")
BRANCH = re.compile(r"factory/[a-z0-9][a-z0-9-]{0,60}")
BASE_SHA = re.compile(r"[0-9a-f]{40}")
# A component made only of dots would turn the URL into a path that climbs out of github.com/<owner>.
REPOSITORY_URL = re.compile(r"https://github\.com/(?!\.+/)[A-Za-z0-9._-]+/(?!\.+\.git)[A-Za-z0-9._-]+\.git")
REQUEST_KEYS = (
    "schema", "job_id", "stage", "skill", "app", "branch", "base_sha", "repository_url", "model",
    "permission_mode", "timeout_minutes", "max_turns", "git_name", "git_email",
)


def is_retry(comment: Comment) -> bool:
    """True when the first non-blank line of the comment is the retry command."""
    for line in comment.body.splitlines():
        if line.strip():
            return line.strip().lower() == RETRY_COMMAND
    return False


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


def choose_app(issue: Issue, apps: Sequence[str], config: Config) -> str | None:
    """The app a run works on: a trusted comment's `app:` line, the issue form, or the only app."""
    candidates = [_app_of_comments(issue, config)]
    if is_trusted(issue.author, config):
        candidates.append(_app_of_form(issue.body))
    if len(apps) == 1:
        candidates.append(apps[0])
    return next((name for name in candidates if name is not None and name in apps), None)


def _cut(text: str) -> str:
    if len(text) <= MAX_ITEM_CHARS:
        return text
    return f"{text[:MAX_ITEM_CHARS]}\n\n(This text was cut after {MAX_ITEM_CHARS} characters.)"


def _title(issue: Issue, config: Config) -> str:
    if not is_trusted(issue.author, config):
        return WITHHELD_TITLE
    return " ".join(issue.title.split())[:MAX_TITLE_CHARS]


def _comment_block(comment: Comment, config: Config, bot: Bot) -> str | None:
    """The comment as a Markdown section, or None when it is not the agent's to read."""
    if _is_bot(comment, bot):
        body = comment.body.split(BOT_MARKER_START, 1)[0].rstrip()
        return f"### The factory at {comment.created_at}\n\n{_cut(body)}" if body else None
    if comment.author != bot.login and is_trusted(comment.author, config):
        return f"### {comment.author} at {comment.created_at}\n\n{_cut(comment.body)}"
    return None


def context(issue: Issue, config: Config, bot: Bot) -> str:
    """The Markdown the agent reads: only text from trusted people and the factory itself."""
    trusted = is_trusted(issue.author, config)
    head = [f"# Issue #{issue.number}: {_title(issue, config)}", _cut(issue.body) if trusted else WITHHELD_BODY]
    blocks = []
    dropped = 0
    for comment in issue.comments:
        block = _comment_block(comment, config, bot)
        if block is not None:
            blocks.append(block)
        elif not _is_bot(comment, bot):
            dropped += 1
    tail = [f"Comments by others, not included: {dropped}."] if dropped else []

    def build(left_out: int) -> str:
        note = [f"Older comments left out to keep this text short: {left_out}."] if left_out else []
        return "\n\n".join([*head, "## Comments", *note, *blocks[left_out:], *tail]) + "\n"

    for left_out in range(len(blocks)):
        text = build(left_out)
        if len(text) <= MAX_CONTEXT_CHARS:
            return text
    return build(len(blocks))


def job_file(*, stage: str, app: str, issue: Issue, branch: str, base_sha: str, config: Config) -> dict:
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
        "round": 0,
    }


def request_file(
    *, job_id: str, stage: str, app: str, branch: str, base_sha: str, repository: str, config: Config, bot: Bot
) -> dict:
    """The `request.json` the runner reads to start the container."""
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
    }


def _matches(pattern: re.Pattern[str], value: object) -> bool:
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _single_line(value: object) -> bool:
    return isinstance(value, str) and bool(value) and "\n" not in value and "\r" not in value


def _integer_in(value: object, key: str) -> bool:
    low, high = STAGE_LIMITS[key]
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def validate_request(data: object) -> list[str]:
    """Every way `data` differs from what `request_file` builds; empty when it is acceptable."""
    if not isinstance(data, dict):
        return ["the request must be an object"]
    problems = [f"{key} is required" for key in REQUEST_KEYS if key not in data]
    problems += [f"{key!r} is not a known key" for key in sorted(map(str, set(data) - set(REQUEST_KEYS)))]
    stage = data.get("stage")
    checks = {
        "schema": data.get("schema") == 1 and not isinstance(data.get("schema"), bool),
        "job_id": _matches(JOB_ID, data.get("job_id")),
        "stage": isinstance(stage, str) and stage in SKILLS,
        "skill": not (isinstance(stage, str) and stage in SKILLS) or data.get("skill") == SKILLS[stage],
        "app": _matches(APP, data.get("app")),
        "branch": _matches(BRANCH, data.get("branch")),
        "base_sha": _matches(BASE_SHA, data.get("base_sha")),
        "repository_url": _matches(REPOSITORY_URL, data.get("repository_url")),
        "model": _matches(MODEL, data.get("model")),
        "permission_mode": data.get("permission_mode") in PERMISSION_MODES,
        "timeout_minutes": _integer_in(data.get("timeout_minutes"), "timeout_minutes"),
        "max_turns": _integer_in(data.get("max_turns"), "max_turns"),
        "git_name": _single_line(data.get("git_name")),
        "git_email": _single_line(data.get("git_email")),
    }
    problems += [f"{key} is not acceptable" for key in REQUEST_KEYS if key in data and not checks[key]]
    return problems

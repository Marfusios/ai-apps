"""PreToolUse hook: refuse new lines that silence a check without a reason, or skip or focus a test."""

import os
import re
from collections.abc import Iterator
from pathlib import Path, PurePosixPath
from typing import NoReturn

import hooklib
from hooklib import Decision

EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".kt",
              ".cs", ".rb", ".php"}
IGNORED_ROOTS = {".claude", "factory", "docs"}
MAX_LINES, MAX_WIDTH = 10, 160
FIX = ("Give the reason on the same line (for ESLint after ` -- `, otherwise at least two words in a comment or "
       "argument), or remove the marker. For a focused test, remove `.only`.")

NOT_AN_ATTRIBUTE = r"(?<![\w.$])"
FOCUSED = re.compile(r"\b(?:describe|it|test|suite|context)(?:\.\w+)*\.only(?:\.\w+)*\(|"  # it.concurrent.only.each(
                     + NOT_AN_ATTRIBUTE + r"(?:fdescribe\(|fit\(\s*['\"`])")  # a bare fit(data) is a model call
SKIPPED = re.compile(r"\b(?:describe|it|test)\.skip\(|" + NOT_AN_ATTRIBUTE + r"x(?:it|describe|test)\(|"
                     r"@pytest\.mark\.skip\b(?!if)|@unittest\.skip(?![A-Za-z])|\bt\.Skip\(\)|#\[ignore\b|"
                     r"@Disabled\b|@Ignore\b")
SUPPRESSION = re.compile(r"eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|biome-ignore|#\s*noqa|"
                         r"#\s*type:\s*ignore|#\s*pylint:\s*disable|#\s*pyright:\s*ignore|//\s*nolint|#!?\[allow\([^)]*\)\]?|"
                         r"@SuppressWarnings|istanbul ignore|c8 ignore|v8 ignore|pragma: no cover|"
                         r"#\s*ruff\s*:\s*noqa|#\s*mypy\s*:\s*ignore-errors|oxlint-disable|deno-lint-ignore|"
                         r"rubocop\s*:\s*disable|phpcs\s*:\s*ignore|@Suppress(?=\()|#\s*pragma\s+warning\s+disable",
                         re.IGNORECASE)
# What may stand between a marker and its reason: an attached rule (":errcheck"), a bracket group, a rule id such as
# "no-console" or "E501", and the position words of the coverage markers.
RULE_LIST = re.compile(r"[:=]\S+|[\[(][^\])]*[\])]|[\w./@-]*[\d_./-][\w./@-]*|(?:next|start|stop|file|if|else)\b")
ARGUMENT = re.compile(r"\s*(?:\((.*)\)|=\s*\"(.*)\"\s*\])")
COMMENT = re.compile(r"(?://|/\*|#)\s*(.*)")


def has_reason(text: str) -> bool:
    """True for at least two words of three or more letters."""
    return len(re.findall(r"[A-Za-z]{3,}", text.replace("*/", " "))) >= 2


def suppression_reason(rest: str) -> str:
    """The reason that follows a suppression marker and its rule list."""
    while True:
        rest = rest.lstrip(" \t,:")
        match = RULE_LIST.match(rest)
        if not match:
            return rest
        rest = rest[match.end():]


def skip_reason(rest: str) -> str:
    """The reason given for a skipped test: an argument of the decorator, else the trailing comment."""
    argument = ARGUMENT.match(rest)
    if argument:
        return re.sub(r"\breason\s*=", " ", argument.group(1) or argument.group(2) or "")
    comment = COMMENT.search(rest)
    return comment.group(1) if comment else ""


def problems(line: str) -> bool:
    """True when the line focuses a test, or skips one or suppresses a check without a reason."""
    if FOCUSED.search(line):
        return True
    for match in SKIPPED.finditer(line):
        if not has_reason(skip_reason(line[match.end():])):
            return True
    for match in SUPPRESSION.finditer(line):
        # ESLint's own syntax puts the reason after ` -- `, so its rule names can never count as one
        reason = line.partition(" -- ")[2] if match.group().lower() == "eslint-disable" else suppression_reason(line[match.end():])
        if not has_reason(reason):
            return True
    return False


def checked(path: str) -> bool:
    parts = PurePosixPath(path.replace("\\", "/")).parts
    return PurePosixPath(path).suffix.lower() in EXTENSIONS and not (parts and parts[0] in IGNORED_ROOTS)


def find_violations(path: str, old_text: str, new_text: str) -> list[str]:
    """The trimmed new lines of new_text that break the rules, for a file at a project-relative path."""
    if not checked(path):
        return []
    existing = {line.strip() for line in old_text.splitlines()}
    lines = (line.strip() for line in new_text.splitlines())
    return [line for line in lines if line and line not in existing and problems(line)]


def texts(tool: str, tool_input: dict, file: Path) -> Iterator[tuple[str, str]]:
    """The (old, new) texts a tool call replaces; nothing for a tool or input it does not understand."""
    if tool == "Edit":
        yield tool_input["old_string"], tool_input["new_string"]
    elif tool == "MultiEdit":
        for edit in tool_input["edits"]:
            yield edit["old_string"], edit["new_string"]
    elif tool == "Write":
        try:
            old = file.read_text(encoding="utf-8", errors="replace")
        except OSError:
            old = ""
        yield old, tool_input["content"]
    elif tool == "NotebookEdit":
        yield "", tool_input["new_source"]


def main() -> NoReturn:
    try:
        data = hooklib.read_input()
        tool, tool_input = data.get("tool_name"), data.get("tool_input")
        path = tool_input.get("notebook_path" if tool == "NotebookEdit" else "file_path") \
            if isinstance(tool_input, dict) else None
        if isinstance(path, str) and path:
            cwd = data.get("cwd")
            project = hooklib.project_dir(data)
            file = Path(os.path.realpath(Path(cwd if isinstance(cwd, str) and cwd else project) / path))
            relative = file.relative_to(os.path.realpath(project)).as_posix()
            if tool == "NotebookEdit":
                relative = str(PurePosixPath(relative).with_suffix(".py"))  # a notebook holds Python by default
            found = [line for old, new in texts(tool, tool_input, file) for line in find_violations(relative, old, new)]
            if found:
                listed = "\n".join(f"  {line[:MAX_WIDTH]}" for line in found[:MAX_LINES])
                hooklib.emit(Decision("deny", f"These new lines silence a check or skip a test without a reason:\n"
                                              f"{listed}\n{FIX}"))
    except (KeyError, TypeError, ValueError, AttributeError, OSError):
        pass  # a file outside the project, or input of an unexpected shape: nothing to judge
    except Exception:  # a quality nudge must never block ordinary work because of its own bug
        pass
    hooklib.emit(Decision("allow"))


if __name__ == "__main__":
    main()

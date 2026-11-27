"""Check the review model's answer and compose the pull request comment that carries its verdict."""

import argparse
import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path

from factory import markers, textsafe

SEVERITIES = ("blocker", "major", "minor")
MAX_FINDINGS = 30
MAX_COMMENT = 60_000  # GitHub accepts 65,536 characters in a comment; this keeps well clear
FAILING = ("blocker", "major")
VERDICT_WORDS = {"pass": "no blocking findings", "fail": "changes needed", "unavailable": "could not run"}
_HEAD = re.compile(r"[0-9a-f]{40}")  # explicit [0-9]: \d would accept other scripts' digits
_MODEL = re.compile(r"[A-Za-z0-9._:-]{1,100}")
_FINDING_LIMITS = {"file": (0, 300), "title": (1, 200), "detail": (1, 2000)}
_FINDING_KEYS = {"severity", "line", *_FINDING_LIMITS}
_SUMMARY_LIMIT = (1, 2000)
MAX_LINE = 10_000_000
_TEXT_LIMIT = 4000  # room for what neutralising adds to a 2,000-character text
_CELL_LIMIT = 300
_DETAIL_CUTS = (_TEXT_LIMIT, 1000, 400, 150, 0)  # tried in turn until the comment fits
_UNAVAILABLE = ("The review could not run or gave no usable answer, so nothing was checked. "
                "A person should review this pull request.")
ESCAPED_PIPE = "\\|"  # keeps a pipe in a title inside its table cell
_CUT_NOTE = "Some detail was left out to fit the comment size limit."


def _text_problems(where: str, value: object, low: int, high: int) -> list[str]:
    if not isinstance(value, str):
        return [f"{where} must be a string"]
    if not low <= len(value) <= high:
        return [f"{where} must be {low} to {high} characters"]
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:  # a lone surrogate written as a JSON escape: the comment could not be written
        return [f"{where} must be text that UTF-8 can hold"]
    return []


def _finding_problems(where: str, finding: object) -> list[str]:
    if not isinstance(finding, dict):
        return [f"{where} must be an object"]
    problems = [f"{where}.{key} is required" for key in sorted(_FINDING_KEYS - set(finding))]
    problems += [f"{where}.{key} is not a known key" for key in sorted(set(finding) - _FINDING_KEYS)]
    if "severity" in finding and finding["severity"] not in SEVERITIES:
        problems.append(f"{where}.severity must be one of {SEVERITIES}")
    line = finding.get("line", 0)
    if not isinstance(line, int) or isinstance(line, bool) or not 0 <= line <= MAX_LINE:
        problems.append(f"{where}.line must be an integer from 0 to {MAX_LINE:,}")
    for key, (low, high) in _FINDING_LIMITS.items():
        if key in finding:
            problems += _text_problems(f"{where}.{key}", finding[key], low, high)
    return problems


def validate(data: object) -> list[str]:
    """Every way the answer departs from the schema; the messages never repeat the answer's own text."""
    if not isinstance(data, dict):
        return ["the answer must be an object"]
    problems = [f"{key} is required" for key in ("summary", "findings") if key not in data]
    problems += [f"{key} is not a known key" for key in sorted(set(data) - {"summary", "findings"})]
    if "summary" in data:
        problems += _text_problems("summary", data["summary"], *_SUMMARY_LIMIT)
    findings = data.get("findings", [])
    if not isinstance(findings, list):
        problems.append("findings must be a list")
    elif len(findings) > MAX_FINDINGS:
        problems.append(f"findings must hold at most {MAX_FINDINGS} items")
    else:
        for index, finding in enumerate(findings):
            problems += _finding_problems(f"findings[{index}]", finding)
    return problems


def verdict(data: Mapping) -> str:
    """`fail` when a finding is a blocker or a major one, else `pass`; the answer must be valid."""
    return "fail" if any(f["severity"] in FAILING for f in data["findings"]) else "pass"


def _quote(text: str) -> str:
    return "\n".join(f"> {line}" if line else ">" for line in text.split("\n"))


def _where(finding: Mapping, *, in_table: bool = False) -> str:
    """The file and line in a code span that a backtick in the file name cannot end."""
    file = textsafe.single_line(finding["file"], _CELL_LIMIT) or "(none)"
    where = f"{file}:{finding['line']}".replace("`", "'")
    return "`" + (where.replace("|", ESCAPED_PIPE) if in_table else where) + "`"


def _title(finding: Mapping) -> str:
    return textsafe.single_line(finding["title"], _CELL_LIMIT)


def _heading(model: str, outcome: str) -> str:
    shown = model if _MODEL.fullmatch(model) else "unknown"
    return f"**Automated review** · model `{shown}` · **{VERDICT_WORDS[outcome]}**"


def _assemble(heading: str, summary: str, table: Sequence[str], details: Sequence[str], note: str, marker: str) -> str:
    parts = [heading, _quote(summary)]
    if table:
        parts.append("\n".join(["| Severity | Where | Finding |", "| --- | --- | --- |", *table]))
    if details:
        parts.append("\n\n".join(details))
    if note:
        parts.append(note)
    return "\n\n".join([*parts, marker]) + "\n"


def _table_row(finding: Mapping) -> str:
    return f"| {finding['severity']} | {_where(finding, in_table=True)} | {_title(finding).replace('|', ESCAPED_PIPE)} |"


def _detail_block(number: int, finding: Mapping, limit: int) -> str:
    detail = textsafe.neutralise(finding["detail"], limit).strip()
    return f"{number}. **{finding['severity']}** {_where(finding)} {_title(finding)}\n\n{_quote(detail)}"


def _findings_comment(data: Mapping, head: str, model: str) -> str | None:
    """The comment, cut until it fits: details first, then findings from the end; None when nothing fits."""
    outcome = verdict(data)
    findings = data["findings"]
    heading = _heading(model, outcome)
    summary = textsafe.neutralise(data["summary"], _TEXT_LIMIT).strip()
    table = [_table_row(f) for f in findings]
    marker = markers.encode_review({"head": head, "verdict": outcome, "findings": len(findings)})
    for limit in _DETAIL_CUTS:
        details = [_detail_block(n, f, limit) for n, f in enumerate(findings, 1)] if limit else []
        note = _CUT_NOTE if findings and limit < _TEXT_LIMIT else ""
        body = _assemble(heading, summary, table, details, note, marker)
        if len(body) <= MAX_COMMENT:
            return body
    for kept in range(len(findings) - 1, 0, -1):
        note = f"{len(findings) - kept} findings were left out to fit the comment size limit."
        body = _assemble(heading, summary, table[:kept], [], note, marker)
        if len(body) <= MAX_COMMENT:
            return body
    return None


def _unavailable(head: str, model: str) -> tuple[str, str]:
    marker = markers.encode_review({"head": head, "verdict": "unavailable", "findings": 0})
    return _assemble(_heading(model, "unavailable"), _UNAVAILABLE, [], [], "", marker), "unavailable"


def comment(answer: str | None, head: str, model: str) -> tuple[str, str]:
    """The comment body and the verdict for the model's raw final message; `head` is the reviewed commit."""
    if not _HEAD.fullmatch(head):
        raise ValueError("head must be 40 lower-case hexadecimal digits")
    try:
        data = json.loads(answer) if answer and answer.strip() else None
    except (ValueError, RecursionError):
        data = None
    if data is None or validate(data):
        return _unavailable(head, model)
    body = _findings_comment(data, head, model)
    return (body, verdict(data)) if body is not None else _unavailable(head, model)


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None  # no answer file is the same as no answer


def _head_argument(value: str) -> str:
    if not _HEAD.fullmatch(value):
        raise argparse.ArgumentTypeError("must be 40 lower-case hexadecimal digits")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    """Write the comment to --out, print the verdict, and return 1 only when the verdict is `fail`."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--answer-file", type=Path, required=True)
    parser.add_argument("--head", type=_head_argument, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        body, outcome = comment(_read(args.answer_file), args.head, args.model)
        encoded = body.encode("utf-8")
    except Exception:  # whatever went wrong, only a `fail` verdict may fail the job
        body, outcome = _unavailable(args.head, args.model)
        encoded = body.encode("utf-8")
    try:
        args.out.write_bytes(encoded)
    except OSError:  # nothing is written, so the workflow posts nothing
        outcome = "unavailable"
    print(outcome)
    return 1 if outcome == "fail" else 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Keep GitHub's labels in line with the factory configuration."""

import argparse
import json
import subprocess
import sys
from collections.abc import Callable, Sequence

from factory.config import Label, load

Runner = Callable[[list[str]], subprocess.CompletedProcess]


def _same(label: Label, found: dict) -> bool:
    color = str(found.get("color") or "").lstrip("#").lower()
    return color == label.color.lower() and (found.get("description") or "") == label.description


def plan(desired: Sequence[Label], existing: Sequence[dict]) -> list[tuple[str, Label]]:
    """Actions that make GitHub match `desired`; labels it does not mention are left alone."""
    by_name = {found["name"]: found for found in existing}
    actions = []
    for label in desired:
        found = by_name.get(label.name)
        if found is None:
            actions.append(("create", label))
        elif not _same(label, found):
            actions.append(("update", label))
    return actions


def run_gh(argv: list[str]) -> subprocess.CompletedProcess:
    """The one place that starts `gh`; argv is a list, never a shell string."""
    return subprocess.run(argv, capture_output=True, text=True, encoding="utf-8", check=False)


def _list_labels(run: Runner) -> list[dict] | None:
    try:
        result = run(["gh", "label", "list", "--limit", "200", "--json", "name,color,description"])
        if result.returncode == 0:
            return json.loads(result.stdout)
        reason = result.stderr.strip() or f"gh exited with {result.returncode}"
    except (OSError, ValueError) as error:
        reason = str(error)
    print(f"Cannot list labels: {reason}", file=sys.stderr)
    return None


def main(argv: Sequence[str] | None = None, run: Runner = run_gh) -> int:
    parser = argparse.ArgumentParser(prog="python -m factory.labels", description=__doc__)
    parser.add_argument("--apply", action="store_true", help="create and update the labels on GitHub")
    args = parser.parse_args(argv)
    existing = _list_labels(run)
    if existing is None:
        return 1
    actions = plan(load().labels, existing)
    if not actions:
        print("Labels are up to date.")
    status = 0
    for action, label in actions:
        print(f"{action} {label.name}", flush=True)
        if not args.apply:
            continue
        result = run(["gh", "label", "create", label.name, "--color", label.color,
                      "--description", label.description, "--force"])
        if result.returncode != 0:
            print(f"Failed to {action} {label.name}: {result.stderr.strip()}", file=sys.stderr)
            status = 1
    return status


if __name__ == "__main__":
    sys.exit(main())

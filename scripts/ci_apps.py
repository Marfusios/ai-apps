#!/usr/bin/env python3
"""Plan and run the per-app checks of the App checks workflow, driven by each app's factory.toml."""

import argparse
import json
import subprocess
import sys
from collections.abc import Collection, Iterable, Sequence
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from factory import app_config, config as factory_config  # noqa: E402 -- the repository root must be on sys.path first

COMMANDS = ("setup", "check")


def touched_apps(paths: Iterable[str], existing: Collection[str]) -> list[str]:
    """Return the sorted names of existing apps a change touches; shared packages touch them all."""
    selected: set[str] = set()
    for path in paths:
        parts = path.split("/")
        if parts[0] == "packages":
            return sorted(existing)
        if len(parts) > 2 and parts[0] == "apps" and parts[1] in existing:
            selected.add(parts[1])
    return sorted(selected)


def matrix(apps: Sequence[str], root: Path, registries: Sequence[str]) -> list[dict]:
    """Return one job description per app; an app whose factory.toml does not load carries its error."""
    entries = []
    for app in apps:
        try:
            loaded = app_config.load(root / "apps" / app, registries)
        except app_config.AppConfigError as error:
            entries.append({"app": app, "node": "", "python": "", "setup": "", "check": "",
                            "error": error.problems[0]})
            continue
        entries.append({"app": app, "node": loaded.toolchain.get("node", ""),
                        "python": loaded.toolchain.get("python", ""),
                        "setup": loaded.setup, "check": loaded.check})
    return entries


def existing_apps(root: Path) -> list[str]:
    apps = root / "apps"
    return sorted(path.name for path in apps.iterdir() if path.is_dir()) if apps.is_dir() else []


def changed_paths(root: Path, base: str, head: str) -> list[str]:
    output = subprocess.check_output(
        ["git", "diff", "--name-only", "--no-renames", f"{base}...{head}"], cwd=root, text=True)
    return output.splitlines()


def print_matrix(root: Path, args: argparse.Namespace) -> int:
    existing = existing_apps(root)
    if args.all:
        apps = existing
    elif args.base and args.head:
        apps = touched_apps(changed_paths(root, args.base, args.head), existing)
    else:
        print("matrix needs --all or both --base and --head", file=sys.stderr)
        return 2
    registries = factory_config.load().image_registries
    print(json.dumps(matrix(apps, root, registries), separators=(",", ":")))
    return 0


def run_command(root: Path, args: argparse.Namespace) -> int:
    if args.app not in existing_apps(root):
        print(f"no app named {args.app}", file=sys.stderr)
        return 2
    app_dir = root / "apps" / args.app
    try:
        loaded = app_config.load(app_dir, factory_config.load().image_registries)
    except app_config.AppConfigError as error:
        print(f"{args.app}: {error.problems[0]}", file=sys.stderr)
        return 1
    command = getattr(loaded, args.command)
    return subprocess.run(["sh", "-c", command], cwd=app_dir, check=False).returncode


def parse(argv: Sequence[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT, help="repository root")
    commands = parser.add_subparsers(dest="action", required=True)
    plan = commands.add_parser("matrix", help="print the job matrix as one line of JSON")
    plan.add_argument("--base")
    plan.add_argument("--head")
    plan.add_argument("--all", action="store_true", help="list every app")
    run = commands.add_parser("run", help="run an app's setup or check command")
    run.add_argument("app")
    run.add_argument("command", choices=COMMANDS)
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse(sys.argv[1:] if argv is None else argv)
    root = args.root.resolve()
    return print_matrix(root, args) if args.action == "matrix" else run_command(root, args)


if __name__ == "__main__":
    sys.exit(main())

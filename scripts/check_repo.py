#!/usr/bin/env python3
"""Check repository conventions offline using only the Python standard library.

This catches common mistakes in current files, not every possible secret or
anything in Git history. Diagnostics never include matched credential values.
"""

import ast
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from factory import app_config, config as factory_config, hygiene  # noqa: E402

SECRET_VARIABLE = re.compile(r"(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)", re.IGNORECASE)
ASSIGNMENT = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
MARKDOWN_LINK = re.compile(r"!?\[[^\]\n]*\]\(([^\s)]+)(?:\s+\"[^\"]*\")?\)")


def repo_files() -> list[Path]:
    output = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=ROOT,
    )
    return sorted({Path(name.decode("utf-8")) for name in output.split(b"\0") if name})


def check_file(path: Path, errors: list[str]) -> None:
    absolute = ROOT / path
    if absolute.is_symlink():
        if not absolute.resolve().is_relative_to(ROOT):
            errors.append(f"{path}: symlink points outside the repository")
        return
    if not absolute.is_file():
        # A tracked deletion is not part of the working tree being checked.
        return
    if hygiene.private_file(path):
        errors.append(f"{path}: local credential file must not be tracked or staged")
        return
    raw = absolute.read_bytes()
    if b"\0" in raw:
        return
    try:
        content = raw.decode("utf-8")
    except UnicodeDecodeError:
        return

    for number, line in enumerate(content.splitlines(), 1):
        for label in hygiene.line_problems(line):
            if label == hygiene.PRIVATE_ADDRESS_LABEL:
                # hygiene.py declares the private ranges it checks; allow those declarations.
                if path == Path("factory/hygiene.py"):
                    continue
                errors.append(f"{path}:{number}: private network address; use portable configuration")
            else:
                errors.append(f"{path}:{number}: {label}; remove it before committing")
        if path.name.endswith(".env.example"):
            assignment = ASSIGNMENT.match(line.strip())
            if assignment and SECRET_VARIABLE.search(assignment[1]):
                value = assignment[2].strip()
                if not re.fullmatch(r"(?:''|\"\")?\s*(?:#.*)?", value):
                    errors.append(f"{path}:{number}: credential example must have an empty value")

    if path.suffix == ".md":
        for match in MARKDOWN_LINK.finditer(content):
            target = match[1].strip("<>")
            parsed = urlsplit(target)
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            linked_path = (absolute.parent / unquote(parsed.path)).resolve()
            if not linked_path.is_relative_to(ROOT) or not linked_path.exists():
                number = content.count("\n", 0, match.start()) + 1
                errors.append(f"{path}:{number}: local Markdown link has no repository target")
    if path.suffix == ".py" and path.parts[0] == "scripts":
        try:
            ast.parse(content, filename=str(path))
        except SyntaxError as error:
            errors.append(f"{path}:{error.lineno}: invalid Python syntax")


def check_factory_tomls(apps: list[Path], errors: list[str]) -> None:
    try:
        registries = factory_config.load().image_registries
    except (factory_config.ConfigError, OSError) as error:
        errors.append(f"factory/config.toml: {error}")
        return
    for app in apps:
        if not (app / "factory.toml").is_file():
            continue  # reported as a missing file
        try:
            app_config.load(app, registries)
        except app_config.AppConfigError as error:
            errors.extend(f"apps/{app.name}/factory.toml: {problem}" for problem in error.problems)


def main() -> int:
    errors: list[str] = []
    try:
        files = repo_files()
    except (FileNotFoundError, subprocess.CalledProcessError):
        print("Run this check inside a Git clone with Git installed.")
        return 1
    for path in files:
        check_file(path, errors)

    apps = sorted(path for path in (ROOT / "apps").iterdir() if path.is_dir())
    catalog = (ROOT / "apps" / "README.md").read_text(encoding="utf-8")
    for app in apps:
        if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", app.name):
            errors.append(f"apps/{app.name}: app directory name must use kebab-case")
        for required in ("README.md", ".env.example", "AGENTS.md", "factory.toml"):
            if not (app / required).is_file():
                errors.append(f"apps/{app.name}: missing {required}")
        if f"]({app.name}/README.md)" not in catalog:
            errors.append(f"apps/{app.name}: missing link in the application catalog")
    check_factory_tomls(apps, errors)

    if errors:
        print("Repository checks failed:")
        for error in errors:
            print(f"  {error}")
        return 1
    print(f"Repository checks passed ({len(files)} files, {len(apps)} apps).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

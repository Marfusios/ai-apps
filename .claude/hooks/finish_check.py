"""Stop hook: hold an unattended factory run open until it leaves its work in a publishable state."""

import contextlib
import json
import os
import signal
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import hooklib

REPO_ROOT = Path(__file__).resolve().parents[2]
GIT_TIMEOUT = 120
KILL_GRACE = 5
DEFAULT_QUICK_TIMEOUT = 600
OUTPUT_TAIL_LINES = 40
NO_COMMIT_STAGES = ("revise", "fix")
REQUIRED_VARIABLES = ("FACTORY_STAGE", "FACTORY_RESULT_PATH", "FACTORY_BASE_SHA")

Run = Callable[[Sequence[str], Path, int], tuple[int, str]]


def tail(output: str, lines: int = OUTPUT_TAIL_LINES) -> str:
    return "\n".join(output.rstrip().splitlines()[-lines:])


def quick_timeout(env: Mapping[str, str]) -> int:
    try:
        seconds = int(float(env.get("FACTORY_QUICK_TIMEOUT", "")))
    except (ValueError, OverflowError):
        return DEFAULT_QUICK_TIMEOUT
    return seconds if seconds > 0 else DEFAULT_QUICK_TIMEOUT


def touched_apps(changed: Sequence[str]) -> list[str]:
    parts = (path.replace("\\", "/").split("/") for path in changed)
    return sorted({p[1] for p in parts if len(p) >= 3 and p[0] == "apps" and p[1]})


def git(run: Run, repo: Path, *args: str) -> tuple[str | None, str]:
    """Run a git command; return its output, or None and the problem when it fails."""
    code, output = run(["git", *args], repo, GIT_TIMEOUT)
    if code != 0:
        return None, f"`git {' '.join(args)}` failed, so the finish check cannot tell whether your work is ready: {tail(output)}"
    return output, ""


def check_app(app: str, repo: Path, env: Mapping[str, str], run: Run, registries: Sequence[str]) -> list[str]:
    from factory import app_config

    app_dir = repo / "apps" / app
    if not app_dir.is_dir():
        return []
    try:
        quick = app_config.load(app_dir, registries).quick
    except app_config.AppConfigError as error:
        return [f"apps/{app}/factory.toml does not load; fix it: " + "; ".join(error.problems)]
    if not quick:
        return []
    seconds = quick_timeout(env)
    code, output = run(["sh", "-c", quick], app_dir, seconds)
    if code == 0:
        return []
    return [f"The quick command of apps/{app} (`{quick}`) failed with exit code {code}; fix what it reports. "
            f"Last lines of its output:\n{tail(output)}"]


def evaluate(env: Mapping[str, str], repo: Path, run: Run) -> list[str]:
    """Return what keeps this run from ending; an empty list means it may stop."""
    if not hooklib.is_factory_run(env):
        return []
    missing = [name for name in REQUIRED_VARIABLES if not env.get(name)]
    if missing:
        return [f"The factory run is missing the environment variable {name}; the finish check cannot run without it."
                for name in missing]
    from factory import config as factory_config
    from factory import result

    stage, result_path, base = env["FACTORY_STAGE"], Path(env["FACTORY_RESULT_PATH"]), env["FACTORY_BASE_SHA"]
    try:
        outcome = result.load(result_path, stage)["outcome"]
    except result.ResultError as error:
        return [f"The result file at {result_path} is not valid; write it again: {problem}" for problem in error.problems]
    if outcome != "done":
        return []

    problems: list[str] = []
    status, problem = git(run, repo, "status", "--porcelain")
    if status is None:
        problems.append(problem)
    elif status.strip():
        problems.append("There is uncommitted work; commit it, or remove files that do not belong:\n" + tail(status))
    if stage not in NO_COMMIT_STAGES:
        count, problem = git(run, repo, "rev-list", "--count", f"{base}..HEAD")
        if count is None:
            problems.append(problem)
        elif not count.strip().isdigit() or int(count) < 1:
            problems.append("There are no commits on top of the base; commit your work.")
    # core.quotePath=false keeps non-ASCII names readable instead of octal-escaped and quoted
    diff, problem = git(run, repo, "-c", "core.quotePath=false", "diff", "--name-only", f"{base}...HEAD")
    changed: list[str] = []
    if diff is None:
        problems.append(problem)
    else:
        changed = [line.strip() for line in diff.splitlines() if line.strip()]
    try:
        settings = factory_config.load()
    except factory_config.ConfigError as error:
        settings = None
        problems.append(f"The factory configuration could not be read, so the writable paths and the apps' quick "
                        f"commands were not checked; tell the person: {error}")
    if settings:
        for path in changed:
            if not factory_config.is_writable(path, settings):
                problems.append(f"{path} is in a path that factory runs may not write; move the change out of it.")
    code, output = run([sys.executable, "scripts/check_repo.py"], repo, GIT_TIMEOUT)
    if code != 0:
        problems.append("The repository checks (scripts/check_repo.py) fail; fix what they report:\n" + tail(output))
    for app in touched_apps(changed) if settings else []:
        problems.extend(check_app(app, repo, env, run, settings.image_registries))
    return problems


def run_command(argv: Sequence[str], cwd: Path, timeout_seconds: int) -> tuple[int, str]:
    """Run a command and return its exit code and combined output; the hook never waits longer than the timeout plus a grace."""
    try:
        process = subprocess.Popen(list(argv), cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, text=True, errors="replace",
                                   start_new_session=os.name != "nt")
    except OSError as error:
        return 127, f"could not run {argv[0]}: {error}"
    try:
        output, _ = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        # Grandchildren are killed on POSIX only; on Windows a survivor is left to finish, but the hook still returns 124.
        if os.name != "nt":
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)
        process.kill()
        collected = ""
        try:
            collected, _ = process.communicate(timeout=KILL_GRACE)
        except subprocess.TimeoutExpired as late:
            if isinstance(late.output, str):
                collected = late.output
        finally:
            process.stdout.close()
        return 124, f"timed out after {timeout_seconds} seconds" + (f"\n{tail(collected)}" if collected.strip() else "")
    return process.returncode, output


def main() -> None:
    if not hooklib.is_factory_run():  # first, and before anything that can fail: a person is never blocked
        sys.exit(0)
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))  # first, so that an installed package named factory cannot shadow it
    data = hooklib.read_input()
    try:
        problems = evaluate(os.environ, hooklib.project_dir(data), run_command)
    except Exception as error:  # fail closed: say that the check itself broke instead of letting the run end
        problems = [f"The finish check itself failed ({type(error).__name__}); tell the person, "
                    "and make sure your work is committed and the result file is written."]
    if problems:
        print(json.dumps({"decision": "block", "reason": "\n".join(problems)}))
    sys.exit(0)


if __name__ == "__main__":
    main()

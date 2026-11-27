"""Stop hook: hold an unattended factory run open until it leaves its work in a publishable state."""

import contextlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path

import hooklib

REPO_ROOT = Path(__file__).resolve().parents[2]
GIT_TIMEOUT = 120
KILL_GRACE = 5
DEFAULT_QUICK_TIMEOUT = 600
MAX_QUICK_TIMEOUT = 600
# Below the 900 seconds of the Stop hook in settings.json: a hook that times out does not block.
DEADLINE_SECONDS = 840
OUTPUT_TAIL_LINES = 40
NO_COMMIT_STAGES = ("revise", "fix")
# The stages whose runs install the app's dependencies; the others write documents only.
QUICK_STAGES = ("step", "fix", "revise", "fix_issue")
REQUIRED_VARIABLES = ("FACTORY_STAGE", "FACTORY_RESULT_PATH", "FACTORY_BASE_SHA")

Run = Callable[[Sequence[str], Path, int], tuple[int, str]]


def tail(output: str, lines: int = OUTPUT_TAIL_LINES) -> str:
    return "\n".join(output.rstrip().splitlines()[-lines:])


def quick_timeout(env: Mapping[str, str]) -> int:
    try:
        seconds = int(float(env.get("FACTORY_QUICK_TIMEOUT", "")))
    except (ValueError, OverflowError):
        return DEFAULT_QUICK_TIMEOUT
    return min(seconds, MAX_QUICK_TIMEOUT) if seconds > 0 else DEFAULT_QUICK_TIMEOUT


def touched_apps(changed: Sequence[str]) -> list[str]:
    parts = (path.replace("\\", "/").split("/") for path in changed)
    return sorted({p[1] for p in parts if len(p) >= 3 and p[0] == "apps" and p[1]})


class Budget:
    """Runs commands against one overall deadline and notes the checks it had no time left to start."""

    def __init__(self, run: Run, now: Callable[[], float], seconds: int = DEADLINE_SECONDS):
        self._run, self._now = run, now
        self._deadline = now() + seconds
        self.skipped: list[str] = []

    def __call__(self, label: str, argv: Sequence[str], cwd: Path, timeout: int) -> tuple[int, str] | None:
        left = self._deadline - self._now()
        if left <= 0:
            self.skipped.append(label)
            return None
        return self._run(argv, cwd, max(1, int(min(timeout, left))))


def git(budget: Budget, repo: Path, label: str, *args: str) -> tuple[str | None, str]:
    """Run a git command; return its output, or None and the problem when it fails or was not started."""
    ran = budget(label, ["git", *args], repo, GIT_TIMEOUT)
    if ran is None:
        return None, ""
    code, output = ran
    if code != 0:
        return None, f"`git {' '.join(args)}` failed, so the finish check cannot tell whether your work is ready: {tail(output)}"
    return output, ""


def check_app(app: str, repo: Path, env: Mapping[str, str], budget: Budget, registries: Sequence[str]) -> list[str]:
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
    ran = budget(f"the quick command of apps/{app}", ["sh", "-c", quick], app_dir, quick_timeout(env))
    if ran is None:
        return []
    code, output = ran
    if code == 0:
        return []
    return [f"The quick command of apps/{app} (`{quick}`) failed with exit code {code}; fix what it reports. "
            f"Last lines of its output:\n{tail(output)}"]


def evaluate(env: Mapping[str, str], repo: Path, run: Run, *,
             now: Callable[[], float] = time.monotonic) -> list[str]:
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
        result_path.open("rb").close()
    except FileNotFoundError:
        return ["No result file yet. Write it at the path in FACTORY_RESULT_PATH, in the shape "
                "factory/AGENT_CONTRACT.md describes."]
    except OSError as error:
        return [f"The result file cannot be read ({type(error).__name__})."]
    try:
        outcome = result.load(result_path, stage)["outcome"]
    except result.ResultError as error:
        return [f"The result file at {result_path} is not valid; write it again: {problem}" for problem in error.problems]
    if outcome != "done":
        return []

    budget = Budget(run, now)
    problems: list[str] = []
    status, problem = git(budget, repo, "git status", "status", "--porcelain")
    if status is None:
        if problem:
            problems.append(problem)
    elif status.strip():
        problems.append("There is uncommitted work; commit it, or remove files that do not belong:\n" + tail(status))
    ancestry = budget("git merge-base", ["git", "merge-base", "--is-ancestor", base, "HEAD"], repo, GIT_TIMEOUT)
    if ancestry is not None and ancestry[0] != 0:
        problems.append("History below the base commit was rewritten: it is no longer an ancestor of HEAD. "
                        "Restore the base commit and put your work back on top of it.")
    if stage not in NO_COMMIT_STAGES:
        count, problem = git(budget, repo, "git rev-list", "rev-list", "--count", f"{base}..HEAD")
        if count is None:
            if problem:
                problems.append(problem)
        elif not count.strip().isdigit() or int(count) < 1:
            problems.append("There are no commits on top of the base; commit your work.")
    # core.quotePath=false keeps non-ASCII names readable instead of octal-escaped and quoted; --no-renames
    # lists the old path of a move too, so a protected file cannot be moved out of its place unseen
    diff, problem = git(budget, repo, "git diff, with the path and touched-app checks that depend on it",
                        "-c", "core.quotePath=false", "diff", "--no-renames", "--name-only", f"{base}...HEAD")
    changed: list[str] = []
    if diff is None:
        if problem:
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
    checked = budget("scripts/check_repo.py", [sys.executable, "scripts/check_repo.py"], repo, GIT_TIMEOUT)
    if checked is not None and checked[0] != 0:
        problems.append("The repository checks (scripts/check_repo.py) fail; fix what they report:\n"
                        + tail(checked[1]))
    if stage in QUICK_STAGES:
        for app in touched_apps(changed) if settings else []:
            problems.extend(check_app(app, repo, env, budget, settings.image_registries))
    if budget.skipped:
        problems.append(f"The finish check ran out of time (it has {DEADLINE_SECONDS} seconds in total), so these "
                        f"checks did not run: {'; '.join(budget.skipped)}. Touch fewer apps in one run, then stop again.")
    return problems


def release(process: subprocess.Popen[bytes], reader: threading.Thread) -> None:
    """Close the pipe unless the reader is still blocked in it, in which case it is abandoned."""
    if not reader.is_alive():
        process.stdout.close()


def run_command(argv: Sequence[str], cwd: Path, timeout_seconds: int) -> tuple[int, str]:
    """Run a command and return its exit code and combined output; nothing here waits without a bound."""
    try:
        process = subprocess.Popen(list(argv), cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, bufsize=0, start_new_session=os.name != "nt")
    except OSError as error:
        return 127, f"could not run {argv[0]}: {error}"
    chunks: list[bytes] = []

    def read_output() -> None:
        fd = process.stdout.fileno()
        try:
            while chunk := os.read(fd, 65536):
                chunks.append(chunk)
        except OSError:
            pass

    # An unbuffered pipe read by our own thread has no lock that close() could wait on, so a reader
    # stuck behind a surviving grandchild can simply be abandoned.
    reader = threading.Thread(target=read_output, daemon=True)
    reader.start()
    try:
        process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        # Grandchildren are killed on POSIX only; on Windows a survivor is left to finish, but the hook still returns 124.
        if os.name != "nt":
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.pid, signal.SIGKILL)
        process.kill()
        with contextlib.suppress(subprocess.TimeoutExpired):
            process.wait(timeout=KILL_GRACE)
        reader.join(KILL_GRACE)
        release(process, reader)
        collected = b"".join(chunks).decode("utf-8", errors="replace")
        return 124, f"timed out after {timeout_seconds} seconds" + (f"\n{tail(collected)}" if collected.strip() else "")
    reader.join(KILL_GRACE)
    release(process, reader)
    return process.returncode, b"".join(chunks).decode("utf-8", errors="replace")


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

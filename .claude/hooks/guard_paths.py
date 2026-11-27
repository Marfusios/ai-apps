"""PreToolUse hook: decide where an agent may write, protecting git internals and credential files."""

import os
import sys
from pathlib import Path, PurePosixPath
from typing import NoReturn

import hooklib
from hooklib import Decision

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))  # first, so that an installed package named factory cannot shadow it

from factory.config import Config, is_writable, load  # noqa: E402  the path must be set before this import

FALLBACK_WRITABLE = ("apps/", "packages/")
WRITE_TOOLS = {"Edit", "Write", "MultiEdit", "NotebookEdit"}
CREDENTIAL_SUFFIXES = {".pem", ".key", ".p12", ".pfx"}
CREDENTIAL_PARTS = {"secrets", "credentials"}
ON_WINDOWS = os.name == "nt"
GIT_REFUSAL = ("Writing inside .git is refused: it holds the repository's own files, hooks included. "
               "Use git commands, and ask the person if a hook needs to change.")


def fallback_config() -> Config:
    """A configuration with the default writable roots, for when config.toml cannot be read."""
    return Config(trusted_logins=(), writable_paths=FALLBACK_WRITABLE, protected_branches=(), image_registries=(),
                  labels=())


def is_credential(parts: list[str]) -> bool:
    """The test of scripts/check_repo.py's private_file, which the hook may not import."""
    name = parts[-1].lower()
    if name.endswith(".env.example"):
        return False
    return (name == ".env" or name.startswith(".env.") or name.endswith(".env") or ".env." in name
            or PurePosixPath(name).suffix in CREDENTIAL_SUFFIXES
            or any(part.lower() in CREDENTIAL_PARTS for part in parts))


def decide(file_path: str, *, project: Path, cwd: Path, factory_run: bool, config: Config) -> Decision:
    """Allow, ask about or deny a write to file_path, which may be relative to cwd."""
    real = Path(os.path.realpath(Path(cwd) / file_path))
    # before the outside-the-project allow: in a linked worktree the real git directory lies outside the project
    if any(part.lower() == ".git" if ON_WINDOWS else part == ".git" for part in real.parts):
        return Decision("deny", GIT_REFUSAL)
    try:
        relative = real.relative_to(os.path.realpath(project))
    except ValueError:
        return Decision("allow")
    text = relative.as_posix().replace("\\", "/")
    parts = [part for part in text.split("/") if part and part != "."]
    if not parts:
        return Decision("allow")
    if ON_WINDOWS:
        text, parts = text.lower(), [part.lower() for part in parts]
    if is_credential(parts):
        if factory_run:
            return Decision("deny", "Writing credential files is refused in a factory run. Document the variable "
                                    "name in .env.example and report the need as a follow-up or a question.")
        return Decision("ask", "This looks like a credential file. Confirm that it should be written.")
    if factory_run and not is_writable(text, config):
        roots = ", ".join(config.writable_paths)
        return Decision("deny", f"A factory run may write only under {roots}. Report the need for this change as a "
                                "follow-up or a question instead of making it.")
    return Decision("allow")


def main() -> NoReturn:
    data = hooklib.read_input()
    tool_input = data.get("tool_input")
    path = None
    if isinstance(tool_input, dict):
        path = tool_input.get("file_path") or tool_input.get("notebook_path")
    if not isinstance(path, str) or not path:
        if data.get("tool_name") in WRITE_TOOLS:  # the input shape may have changed: fail closed
            hooklib.emit(Decision("deny", "The path guard was given no path to inspect for this write."))
        hooklib.emit(Decision("allow"))
    project = hooklib.project_dir(data)
    cwd = data.get("cwd")
    try:
        try:
            config = load()
        except Exception:  # whatever is wrong with the configuration, the default roots still hold
            config = fallback_config()
        decision = decide(path, project=project, cwd=Path(cwd) if isinstance(cwd, str) and cwd else project,
                          factory_run=hooklib.is_factory_run(), config=config)
    except Exception:  # a guard that crashes lets the write through
        decision = Decision("deny", "The path guard could not inspect this path. Write to a plain path under apps/.")
    hooklib.emit(decision)


if __name__ == "__main__":
    main()

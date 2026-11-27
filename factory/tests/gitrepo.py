"""Real git repositories for tests, built in the index from strings and isolated from the user's configuration."""

import os
import subprocess
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

NAME = "Test Person"
EMAIL = "person@example.com"
SUBMODULE_MODE = "160000"
REMOVED = "0 " + "0" * 40  # what `update-index --index-info` reads as "remove this path"


@dataclass(frozen=True)
class Tree:
    """A tree already written, placed in a layout by its sha so that many directories can share it."""

    sha: str


Layout = Mapping[str, "str | bytes | Tree | Layout"]


def environment(**extra: str) -> dict[str, str]:
    """The caller's environment without its git settings, so no user or system configuration reaches git."""
    env = {name: value for name, value in os.environ.items() if not name.upper().startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0", **extra)
    return env


def _run(args: Sequence[str], input: bytes | None, extra: Mapping[str, str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", *args], input=input, stdin=subprocess.DEVNULL if input is None else None, capture_output=True,
        env=environment(**extra), check=False,
    )


def git(*args: str, input: bytes | None = None, **extra: str) -> str:
    """Run git and return its output without the final newline; a failure raises with git's own message."""
    done = _run(args, input, extra)
    if done.returncode:
        raise AssertionError(f"git {' '.join(args)} failed: {done.stderr.decode('utf-8', 'replace')}")
    return done.stdout.decode("utf-8", "replace").rstrip("\n")


def _records(lines: Sequence[str]) -> bytes:
    return b"".join(line.encode("utf-8") + b"\x00" for line in lines)


class Repo:
    """A repository whose work tree is never written: files go straight into the index and from there into commits.

    Because nothing is checked out, a link or a submodule never touches the file system, and these tests run the
    same on every platform.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self._blobs: dict[bytes, str] = {}  # content to sha: a blob, once written, stays
        git("init", "-q", "-b", "main", str(self.path))

    def git(self, *args: str, input: bytes | None = None, **extra: str) -> str:
        return git("-C", str(self.path), *args, input=input, **extra)

    @property
    def head(self) -> str:
        return self.git("rev-parse", "HEAD")

    def blob(self, content: str | bytes) -> str:
        data = content.encode("utf-8") if isinstance(content, str) else content
        if data not in self._blobs:
            self._blobs[data] = self.git("hash-object", "-w", "--stdin", input=data)
        return self._blobs[data]

    def commit(
        self,
        files: Mapping[str, str | bytes | None],
        *,
        message: str = "change",
        name: str = NAME,
        email: str = EMAIL,
        mode: Mapping[str, str] | None = None,
        committer: tuple[str, str] | None = None,
    ) -> str:
        """Commit on the current branch. `None` deletes a file; a `160000` entry's content is the commit it names."""
        modes = mode or {}
        lines = []
        for path, content in files.items():
            if content is None:
                lines.append(f"{REMOVED}\t{path}")
                continue
            entry_mode = modes.get(path, "100644")
            sha = str(content) if entry_mode == SUBMODULE_MODE else self.blob(content)
            lines.append(f"{entry_mode} {sha}\t{path}")
        staged = _run(["-C", str(self.path), "update-index", "-z", "--index-info"], _records(lines), {})
        if staged.returncode or staged.stderr:  # a refused path is only a warning, so a test would build less
            raise AssertionError(f"the index refused a path: {staged.stderr.decode('utf-8', 'replace')}")
        born = _run(["-C", str(self.path), "rev-parse", "--verify", "--quiet", "HEAD"], None, {}).returncode == 0
        return self.commit_tree(self.git("write-tree"), [self.head] if born else [], message=message, name=name,
                                email=email, committer=committer)

    def commit_tree(
        self,
        tree: str,
        parents: Sequence[str],
        *,
        message: str = "change",
        name: str = NAME,
        email: str = EMAIL,
        committer: tuple[str, str] | None = None,
    ) -> str:
        """Commit a tree with any parents and move the current branch to it, whatever its history."""
        committer_name, committer_email = committer or (name, email)
        arguments = ["commit-tree", tree, "-m", message]
        for parent in parents:
            arguments += ["-p", parent]
        sha = self.git(*arguments, GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email,
                       GIT_COMMITTER_NAME=committer_name, GIT_COMMITTER_EMAIL=committer_email)
        self.git("update-ref", "HEAD", sha)
        return sha

    def raw_commit(self, headers: Sequence[str], message: str = "change") -> str:
        """Write a commit object exactly as given, however malformed, and move the current branch to it."""
        content = "\n".join(headers) + "\n\n" + message + "\n"
        sha = self.git("hash-object", "-t", "commit", "-w", "--stdin", "--literally", input=content.encode("utf-8"))
        self.git("update-ref", "HEAD", sha)
        return sha

    def tree(self, layout: Layout) -> str:
        """Write a tree with `git mktree`, which takes names the index refuses, such as `.GIT` or `..`."""
        lines = []
        for name, value in layout.items():
            if isinstance(value, Tree):
                lines.append(f"040000 tree {value.sha}\t{name}")
            elif isinstance(value, Mapping):
                lines.append(f"040000 tree {self.tree(value)}\t{name}")
            else:
                lines.append(f"100644 blob {self.blob(value)}\t{name}")
        return self.git("mktree", "-z", input=_records(lines))

    def switch(self, branch: str, start: str | None = None) -> None:
        """Make `branch` the current branch, created or moved to `start` (the current head by default)."""
        self.git("update-ref", f"refs/heads/{branch}", start or self.head)
        self.git("symbolic-ref", "HEAD", f"refs/heads/{branch}")
        self.git("read-tree", "HEAD")

    def bundle(self, base: str, branch: str, out: Path) -> Path:
        self.git("bundle", "create", str(out), f"{base}..refs/heads/{branch}")
        return Path(out)

    def bare_clone(self, dest: Path) -> Path:
        git("clone", "-q", "--bare", str(self.path), str(dest))
        return Path(dest)

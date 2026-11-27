"""Judge the commits a runner hands over as a git bundle, read purely as data in the dispatcher's own repository."""

import itertools
import os
import posixpath
import re
import stat
import unicodedata
from dataclasses import dataclass
from pathlib import Path, PurePosixPath

from factory import hygiene, spool
from factory.config import Config, is_writable
from factory.gitops import ANSWERED_NO, SHA, WORK_BRANCH, GitError, resolve, run_git
from factory.snapshot import Bot

MEGABYTE = 1024 * 1024
MAX_PROBLEMS = 20
MAX_ENTRIES = 2000
MAX_LINK_TARGET = 4096  # the longest path Linux resolves; a longer target is not a usable link
SHORT_SHA = 12
SHOWN_PATH = 200
BLOB_MODES = ("100644", "100755", "120000")
LINK_MODE = "120000"
SUBMODULE_MODE = "160000"
IDENTITY_FORMAT = "--format=%an%x00%ae%x00%cn%x00%ce"
HEAD_LISTING = re.compile(rb"([0-9a-f]{40}) ([^\n]*)\n")
RAW_ENTRY = re.compile(rb":[0-7]{6} ([0-7]{6}) [0-9a-f]{40} ([0-9a-f]{40}) ([A-Z])")
COUNT = re.compile(rb"[0-9]{1,12}\n")
DRIVE = re.compile(r"[A-Za-z]:")

MALFORMED = "the job is malformed"
NOT_THE_BRANCH = "the bundle does not hold exactly the work branch"
UNREADABLE = "the bundle could not be read"
NOT_ON_BASE = "the commits do not sit on top of the expected base"
NO_COMMITS = "there are no commits"
WITHHELD_PATH = "a path that is not shown"

Problem = tuple[int, str]  # the number of the check that found it, then the sentence


@dataclass(frozen=True)
class Verdict:
    ok: bool
    head_sha: str | None
    commits: int
    problems: tuple[str, ...]


class _Unreadable(Exception):
    """Git answered in a shape this module does not expect."""


@dataclass(frozen=True)
class _Entry:
    """One path a commit changes, as `git diff-tree --raw` lists it."""

    commit: str
    mode: str  # the new mode, 000000 when the path is deleted
    blob: str
    deleted: bool
    path: str  # decoded as UTF-8, with U+FFFD where the bytes were not


@dataclass(frozen=True)
class _Blob:
    too_large: bool
    findings: tuple[tuple[int, str], ...]  # hygiene's line numbers and labels
    target: str | None  # the content as a link target: NUL-free UTF-8 of at most MAX_LINK_TARGET characters


def _verdict(head: str | None, commits: int, problems: list[Problem]) -> Verdict:
    sentences = [sentence for _, sentence in sorted(problems, key=lambda problem: problem[0])]
    if len(sentences) > MAX_PROBLEMS:
        sentences = sentences[:MAX_PROBLEMS] + [f"and {len(sentences) - MAX_PROBLEMS} more"]
    return Verdict(not sentences, head, commits, tuple(sentences))


def _job_is_wellformed(base_sha: object, branch: object, job_id: object) -> bool:
    """The job's own values reach git as revisions and ref names, so each must be exactly what it claims to be."""
    expected = ((base_sha, SHA), (branch, WORK_BRANCH), (job_id, spool.JOB_ID))
    return all(isinstance(value, str) and pattern.fullmatch(value) for value, pattern in expected)


def _is_regular_file_within(path: Path, limit: int) -> bool:
    try:
        info = os.lstat(path)
    except OSError:
        return False
    return stat.S_ISREG(info.st_mode) and info.st_size <= limit


def _listed_head(workrepo: Path, bundle: Path, branch: str) -> str | None:
    """The commit the bundle names for the work branch, when that branch is the only ref it holds."""
    try:
        listing = run_git(workrepo, "bundle", "list-heads", str(bundle))
    except GitError:
        return None
    match = HEAD_LISTING.fullmatch(listing)
    if match is None or match.group(2) != f"refs/heads/{branch}".encode("ascii"):
        return None
    return match.group(1).decode("ascii")


def _number(output: bytes) -> int:
    if not COUNT.fullmatch(output):
        raise _Unreadable
    return int(output)


def _fetch(workrepo: Path, bundle: Path, branch: str, job_id: str, listed: str) -> str:
    """Fetch the work branch into a quarantine ref and return the commit it names.

    The fsck settings make git check every incoming object, but only git 2.46 and later apply them to a bundle, so
    the checks after this one never rely on them.
    """
    quarantine = f"refs/quarantine/{job_id}"
    run_git(workrepo, "-c", "fetch.fsckObjects=true", "-c", "transfer.fsckObjects=true", "fetch", "--no-tags",
            "--no-recurse-submodules", "--", str(bundle), f"refs/heads/{branch}:{quarantine}")
    head = resolve(workrepo, quarantine)
    if head != listed:
        raise _Unreadable  # the branch names a tag or some other object, not a commit
    return head


def _count(workrepo: Path, base: str, head: str, max_commits: int) -> tuple[int, str | None]:
    """How many commits sit on top of the base, and the problem that stops the check, if any."""
    try:
        run_git(workrepo, "merge-base", "--is-ancestor", base, head)
    except GitError as error:
        if error.status != ANSWERED_NO:
            raise
        return 0, NOT_ON_BASE
    count = _number(run_git(workrepo, "rev-list", "--count", f"{base}..{head}"))
    if count == 0:
        return 0, NO_COMMITS
    if count > max_commits:
        return count, f"there are more than {max_commits} commits"
    return count, None


def _commits(workrepo: Path, base: str, head: str) -> list[tuple[str, list[str]]]:
    """Each commit on top of the base with its parents, oldest first."""
    output = run_git(workrepo, "rev-list", "--reverse", "--parents", f"{base}..{head}")
    commits = []
    for line in output.decode("ascii", "replace").splitlines():
        shas = line.split(" ")
        if not all(SHA.fullmatch(sha) for sha in shas):
            raise _Unreadable
        commits.append((shas[0], shas[1:]))
    return commits


def _commit_labels(workrepo: Path, sha: str) -> list[str]:
    """Hygiene labels anywhere in the commit object: its message and its headers are published with it."""
    text = run_git(workrepo, "cat-file", "commit", sha).decode("utf-8", "replace")
    return list(dict.fromkeys(label for _, label in hygiene.text_problems(text)))


def _changes(workrepo: Path, parent: str, sha: str) -> list[_Entry]:
    output = run_git(workrepo, "diff-tree", "-r", "--no-renames", "--raw", "-z", "--ignore-submodules=none",
                     parent, sha)
    fields = output.split(b"\x00")
    if fields.pop() != b"" or len(fields) % 2:
        raise _Unreadable
    entries = []
    for meta, path in zip(fields[0::2], fields[1::2]):
        match = RAW_ENTRY.fullmatch(meta)
        if match is None:
            raise _Unreadable
        mode, blob, status = (group.decode("ascii") for group in match.groups())
        entries.append(_Entry(sha, mode, blob, status == "D", path.decode("utf-8", "replace")))
    return entries


def _shown(path: str) -> str:
    """A path from the bundle as a public comment may show it.

    Printable ASCII only, cut short, and withheld whole when it holds what looks like a secret, a host path or a
    private address.
    """
    shown = "".join(char if " " <= char <= "~" else "?" for char in path)[:SHOWN_PATH]
    if hygiene.line_problems(path) or hygiene.line_problems(shown):
        return WITHHELD_PATH
    return shown


def _as_stored(name: str) -> str:
    """A name as a case-insensitive file system sees it.

    NTFS also drops a stream suffix and trailing dots and spaces, so `.GIT`, `.git.` and `.git::$INDEX_ALLOCATION`
    all name the `.git` directory.
    """
    return name.split(":", 1)[0].rstrip(". ").lower()


def _is_odd_character(char: str) -> bool:
    """A backslash, the mark of bytes that were not UTF-8, or a control, format, private or unassigned character."""
    return char in ("\\", "\N{REPLACEMENT CHARACTER}") or unicodedata.category(char).startswith("C")


def _is_writable(path: str, config: Config) -> bool:
    """Writable by the configuration, and spelled so that no file system reads it as some other path."""
    if any(_is_odd_character(char) for char in path):
        return False
    if any(name in ("", ".", "..") or _as_stored(name) in (".git", "git~1") for name in path.split("/")):
        return False
    return is_writable(path, config)


def _addition_problem(entry: _Entry) -> str | None:
    if entry.mode == SUBMODULE_MODE or _as_stored(posixpath.basename(entry.path)) in (".gitmodules", "gitmod~1"):
        return "a submodule"
    if entry.mode not in BLOB_MODES:
        return "a file mode that is not allowed"
    if hygiene.private_file(PurePosixPath(entry.path)):
        return "a credential file"
    labels = hygiene.line_problems(entry.path)
    return f"a name that contains {labels[0]}" if labels else None


def _leaves(path: str, target: str) -> bool:
    """Whether a link at `path` can reach outside the repository.

    `..` may only lead the target: after a name it climbs from wherever that name points, and another link in the
    tree can point anywhere, so a target such as `up/../../..` escapes even though it reads as staying inside.
    """
    if not target or target.startswith("/") or DRIVE.match(target) or "\\" in target:
        return True
    names = [name for name in target.split("/") if name not in ("", ".")]
    if ".." in itertools.dropwhile(lambda name: name == "..", names):
        return True
    return posixpath.normpath(posixpath.join(posixpath.dirname(path), target)).startswith(("..", "/"))


def _decoded(content: bytes) -> str | None:
    """The content as text when it is UTF-8 without a NUL byte; anything else is treated as binary."""
    if b"\x00" in content:
        return None
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return None


class _Blobs:
    """The blobs the commits add, each read at most once and only when it is within the size limit."""

    def __init__(self, workrepo: Path, megabytes: int) -> None:
        self._workrepo = workrepo
        self._megabytes = megabytes
        self._known: dict[str, _Blob] = {}

    def _blob(self, sha: str) -> _Blob:
        if sha not in self._known:
            if _number(run_git(self._workrepo, "cat-file", "-s", sha)) > self._megabytes * MEGABYTE:
                self._known[sha] = _Blob(too_large=True, findings=(), target=None)
            else:
                text = _decoded(run_git(self._workrepo, "cat-file", "blob", sha))
                self._known[sha] = _Blob(
                    too_large=False,
                    findings=tuple(hygiene.text_problems(text)) if text is not None else (),
                    target=text if text is not None and len(text) <= MAX_LINK_TARGET else None,
                )
        return self._known[sha]

    def problems(self, entry: _Entry) -> list[str]:
        blob = self._blob(entry.blob)
        if blob.too_large:
            return [f"larger than {self._megabytes} MB"]
        reasons = []
        if entry.mode == LINK_MODE and (blob.target is None or _leaves(entry.path, blob.target)):
            reasons.append("a link that leaves the repository")
        return reasons + [f"line {line}: {label}" for line, label in blob.findings]


def _entry_problems(entry: _Entry, config: Config, blobs: _Blobs) -> list[Problem]:
    where, shown = f"commit {entry.commit[:SHORT_SHA]}", _shown(entry.path)
    problems = []
    if not _is_writable(entry.path, config):
        problems.append((7, f"{where} changes {shown}, which is outside the writable paths"))
    if entry.deleted:
        return problems
    addition = _addition_problem(entry)
    if addition is not None:
        problems.append((8, f"{where} adds {shown}: {addition}"))
    if entry.mode in BLOB_MODES:
        problems.extend((9, f"{where} adds {shown}: {content}") for content in blobs.problems(entry))
    return problems


def _judge_commits(workrepo: Path, base: str, head: str, bot: Bot, config: Config, problems: list[Problem]) -> None:
    """Checks 5 to 10 over the commits, oldest first.

    Problems go into `problems` as they are found, so that they survive a git failure further on.
    """
    identity = f"{bot.login}\0{bot.email}\0{bot.login}\0{bot.email}\n".encode("utf-8")
    entries: list[_Entry] = []
    changed = 0
    for sha, parents in _commits(workrepo, base, head):
        where = f"commit {sha[:SHORT_SHA]}"
        if len(parents) != 1:
            problems.append((5, f"{where} is a merge"))
        # Compared as whole bytes: a NUL inside a name cannot shift the fields into place.
        if run_git(workrepo, "show", "-s", "--no-use-mailmap", IDENTITY_FORMAT, sha) != identity:
            problems.append((6, f"{where} is not authored by the factory's identity"))
        problems.extend((6, f"{where} has a message or header that contains {label}")
                        for label in _commit_labels(workrepo, sha))
        if len(parents) == 1 and changed <= MAX_ENTRIES:
            found = _changes(workrepo, parents[0], sha)
            changed += len(found)
            entries.extend(found[: MAX_ENTRIES - len(entries)])
    blobs = _Blobs(workrepo, config.dispatcher.max_file_megabytes)
    for entry in entries:
        problems.extend(_entry_problems(entry, config, blobs))
    if changed > MAX_ENTRIES:
        problems.append((10, f"the commits change more than {MAX_ENTRIES:,} files"))


def check(bundle: Path, *, workrepo: Path, base_sha: str, branch: str, job_id: str, bot: Bot,
          config: Config) -> Verdict:
    """Decide whether the bundle's commits may be pushed to `branch` under the factory's name.

    Never raises for anything a bundle can hold: every failure, git's included, becomes a problem in the verdict.
    The fetched head stays at `refs/quarantine/<job_id>` in the work repository for the push.
    """
    if not _job_is_wellformed(base_sha, branch, job_id):
        return _verdict(None, 0, [(0, MALFORMED)])
    megabytes = config.dispatcher.max_bundle_megabytes
    path = Path(bundle).absolute()  # an absolute path never reads to git as an option
    if not _is_regular_file_within(path, megabytes * MEGABYTE):
        return _verdict(None, 0, [(1, f"the bundle is missing or larger than {megabytes} MB")])
    listed = _listed_head(workrepo, path, branch)
    if listed is None:
        return _verdict(None, 0, [(2, NOT_THE_BRANCH)])
    head, count, problems = None, 0, []
    try:
        head = _fetch(workrepo, path, branch, job_id, listed)
        count, stop = _count(workrepo, base_sha, head, config.dispatcher.max_commits)
        if stop is not None:
            return _verdict(head, count, [(4, stop)])
        _judge_commits(workrepo, base_sha, head, bot, config, problems)
    except (GitError, _Unreadable):
        problems.append((3, UNREADABLE))
    return _verdict(head, count, problems)

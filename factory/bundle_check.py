"""Judge the commits a runner hands over as a git bundle, read purely as data in the dispatcher's own repository.

`check` runs these checks in order; one marked "stop" ends the check when it fails:

1. the bundle is a regular file within the size limit (stop);
2. it holds exactly one ref, the work branch (stop);
3. git fetches it into a quarantine ref that names the commit the bundle lists (stop);
4. the head descends from the base, with 1 to `max_commits` commits on top of it, listed within a cap (stop);
5. no commit is a merge;
6. every commit object is small, holds exactly the headers the factory's git writes, with the bot as author and
   committer, and has no hygiene finding;
7. every changed path is writable and spelled so that no file system reads it as another path;
8. no added entry is a submodule, has another file mode, is a credential file or has a credential in its name;
9. no added blob is too large, no link leaves the repository, holds a character a path may not, points into
   .git or names a credential, no other content has a hygiene finding, and all of it together stays within what
   the factory scans (stop);
10. at most 2,000 changed entries over all commits, listed within a cap (stop).

Everything git prints about the bundle is read under a cap, so that a small bundle cannot make the dispatcher
hold much memory, and git's own failures become problems, so that `check` never raises for a bundle.
"""

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
from factory.gitops import ANSWERED_NO, SHA, WORK_BRANCH, GitError, GitOutputTooLarge, resolve, run_git
from factory.snapshot import Bot

MEGABYTE = 1024 * 1024
MAX_PROBLEMS = 20
MAX_ENTRIES = 2000
MAX_COMMIT_BYTES = 100_000
MAX_SCANNED_BYTES = 50_000_000
PATH_MAX = 4096  # the longest path Linux resolves: no usable link target is longer
SHORT_SHA = 12
SHOWN_PATH = 200
# Caps on what git may print about the bundle, each sized for the most a bundle that passes could need.
LIST_HEADS_LIMIT = 100_000
REV_LIST_LINE = 3 * 41  # a commit and up to two parents, each 40 hex digits and a separator
DIFF_LIMIT = (MAX_ENTRIES + 1) * (100 + PATH_MAX)  # a raw entry is about 100 bytes and its path
OUTPUT_MARGIN = 4096
BLOB_MODES = ("100644", "100755", "120000")
LINK_MODE = "120000"
SUBMODULE_MODE = "160000"
GIT_DIRECTORY = (".git", "git~1")  # as `_as_stored` spells it; git~1 is its NTFS short name
GIT_MODULES = (".gitmodules", "gitmod~1")
HEAD_LISTING = re.compile(rb"([0-9a-f]{40}) ([^\n]*)\n")
RAW_ENTRY = re.compile(rb":[0-7]{6} ([0-7]{6}) [0-9a-f]{40} ([0-9a-f]{40}) ([A-Z])")
HASH_HEADER = re.compile(rb"(tree|parent) [0-9a-f]{40}")
PERSON_HEADER = re.compile(rb"(author|committer) (.*)")
COUNT = re.compile(rb"[0-9]{1,12}\n")
DRIVE = re.compile(r"[A-Za-z]:")
# An app may well have a `src/home/` directory: in names and link targets only credentials are refused.
NOT_A_CREDENTIAL = "personal filesystem path"
CREDENTIAL_PATTERNS = tuple((label, pattern) for label, pattern in hygiene.PATTERNS if label != NOT_A_CREDENTIAL)
CREDENTIAL_LABELS = frozenset(label for label, _ in CREDENTIAL_PATTERNS)

MALFORMED = "the job is malformed"
NOT_THE_BRANCH = "the bundle does not hold exactly the work branch"
UNREADABLE = "the bundle could not be read"
NOT_ON_BASE = "the commits do not sit on top of the expected base"
NO_COMMITS = "there are no commits"
COMMITS_TOO_LONG = "the list of commits is too long to check"
TOO_MANY_FILES = f"the commits change more than {MAX_ENTRIES:,} files"
FILES_TOO_LONG = f"{TOO_MANY_FILES}, or their paths are too long to check"  # the cap on git's output says no more
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


class _Stop(Exception):
    """A problem after which nothing more is checked."""

    def __init__(self, check: int, sentence: str) -> None:
        super().__init__(sentence)
        self.problem: Problem = (check, sentence)


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
    findings: tuple[tuple[int, str], ...]  # hygiene's line numbers and labels, the first few only
    target: str | None  # the content as a link target, when it can be one


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
        listing = run_git(workrepo, "bundle", "list-heads", str(bundle), max_output=LIST_HEADS_LIMIT)
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


def _commits_on_base(workrepo: Path, base: str, head: str, max_commits: int) -> list[tuple[str, list[str]]]:
    """The commits on top of the base, oldest first, each with its parents.

    Stops the check when the head does not descend from the base, or when there are no commits, too many, or a
    list too long to read: a commit with many parents makes a long line, so an overflow says nothing of the count.
    """
    try:
        run_git(workrepo, "merge-base", "--is-ancestor", base, head)
    except GitError as error:
        if error.status != ANSWERED_NO:
            raise
        raise _Stop(4, NOT_ON_BASE) from None
    try:
        output = run_git(workrepo, "rev-list", "--reverse", "--parents", f"{base}..{head}",
                         max_output=(max_commits + 1) * REV_LIST_LINE)
    except GitOutputTooLarge:
        raise _Stop(4, COMMITS_TOO_LONG) from None
    commits = []
    for line in output.decode("ascii", "replace").splitlines():
        shas = line.split(" ")
        if not all(SHA.fullmatch(sha) for sha in shas):
            raise _Unreadable
        commits.append((shas[0], shas[1:]))
    if not commits:
        raise _Stop(4, NO_COMMITS)
    if len(commits) > max_commits:
        raise _Stop(4, f"there are more than {max_commits} commits")
    return commits


def _identity(bot: Bot) -> re.Pattern[bytes]:
    """The bot's author or committer value exactly as git writes it: `login <email> seconds zone`."""
    return re.compile(re.escape(f"{bot.login} <{bot.email}>".encode("utf-8")) + rb" [0-9]+ [+-][0-9]{4}")


def _header_problems(raw: bytes, identity: re.Pattern[bytes], where: str) -> list[Problem]:
    """Checks 5 and 6 on a commit's headers, read as bytes rather than through git's formatted view.

    git's formats read the last of repeated author or committer lines while `git log` and GitHub show the first,
    so the headers must be exactly the lines the factory's git writes: tree, parent, author and committer.
    """
    header, blank, _ = raw.partition(b"\n\n")
    kinds, people = [], []
    for line in header.split(b"\n"):
        hashed, person = HASH_HEADER.fullmatch(line), PERSON_HEADER.fullmatch(line)
        if hashed:
            kinds.append(hashed.group(1))
        elif person:
            kinds.append(person.group(1))
            people.append(person.group(2))
        else:
            kinds.append(b"other")
    parents = kinds.count(b"parent")
    problems = []
    if parents > 1:
        problems.append((5, f"{where} is a merge"))
    one_each = kinds.count(b"author") == kinds.count(b"committer") == 1
    if not (one_each and all(identity.fullmatch(person) for person in people)):
        problems.append((6, f"{where} is not authored by the factory's identity"))
    if not blank or parents == 0 or kinds != [b"tree", *[b"parent"] * parents, b"author", b"committer"]:
        problems.append((6, f"{where} has headers the factory does not write"))
    return problems


def _commit_problems(workrepo: Path, sha: str, identity: re.Pattern[bytes]) -> list[Problem]:
    """Checks 5 and 6 on one commit object; its message and headers are published with it."""
    where = f"commit {sha[:SHORT_SHA]}"
    if _number(run_git(workrepo, "cat-file", "-s", sha)) > MAX_COMMIT_BYTES:
        return [(6, f"{where} is larger than a commit may be")]
    raw = run_git(workrepo, "cat-file", "commit", sha, max_output=MAX_COMMIT_BYTES)
    labels = dict.fromkeys(label for _, label in hygiene.text_problems(raw.decode("utf-8", "replace")))
    return _header_problems(raw, identity, where) + [
        (6, f"{where} has a message or header that contains {label}") for label in labels
    ]


def _changes(workrepo: Path, parent: str, sha: str) -> list[_Entry]:
    """The entries a commit changes; shared subtrees can make a tiny commit list millions, hence the cap.

    An overflow says too many entries or too long a path, not which, so its sentence names both.
    """
    try:
        output = run_git(workrepo, "diff-tree", "-r", "--no-renames", "--raw", "-z", "--ignore-submodules=none",
                         parent, sha, max_output=DIFF_LIMIT)
    except GitOutputTooLarge:
        raise _Stop(10, FILES_TOO_LONG) from None
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


def _credential_labels(text: str) -> list[str]:
    return [label for label, pattern in CREDENTIAL_PATTERNS if pattern.search(text)]


def _shown(path: str) -> str:
    """A path from the bundle as a public comment may show it.

    Printable ASCII only, cut short, and withheld whole when it holds what looks like a credential.
    """
    shown = "".join(char if " " <= char <= "~" else "?" for char in path)[:SHOWN_PATH]
    if _credential_labels(path) or _credential_labels(shown):
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
    if any(name in ("", ".", "..") or _as_stored(name) in GIT_DIRECTORY for name in path.split("/")):
        return False
    return is_writable(path, config)


def _addition_problem(entry: _Entry) -> str | None:
    if entry.mode == SUBMODULE_MODE or _as_stored(posixpath.basename(entry.path)) in GIT_MODULES:
        return "a submodule"
    if entry.mode not in BLOB_MODES:
        return "a file mode that is not allowed"
    if hygiene.private_file(PurePosixPath(entry.path)):
        return "a credential file"
    labels = _credential_labels(entry.path)
    return f"a name that contains {labels[0]}" if labels else None


def _leaves(path: str, target: str) -> bool:
    """Whether a link at `path` can reach outside the repository, or somewhere a file system reads differently.

    A target holds no character that a path may not hold: a zero-width joiner or a byte order mark inside `.git`
    would otherwise hide it from the name test. `..` may only lead the target: after a name it climbs from wherever
    that name points, and another link in the tree can point anywhere, so a target such as `up/../../..` escapes
    even though it reads as staying inside.
    """
    if not target or target.startswith("/") or DRIVE.match(target) or any(map(_is_odd_character, target)):
        return True
    names = [name for name in target.split("/") if name not in ("", ".")]
    if ".." in itertools.dropwhile(lambda name: name == "..", names):
        return True
    return posixpath.normpath(posixpath.join(posixpath.dirname(path), target)).startswith(("..", "/"))


def _into_git(target: str) -> bool:
    return any(_as_stored(name) in GIT_DIRECTORY for name in target.split("/"))


def _findings(content: bytes) -> tuple[tuple[int, str], ...]:
    """Hygiene's findings in any content, text or binary: a byte that is not UTF-8 must not hide a key.

    Like `hygiene.text_problems`, but it stops after the first few: a problem list shows no more than MAX_PROBLEMS,
    and a file full of findings must not fill memory with problem sentences.
    """
    lines = content.decode("utf-8", "replace").splitlines()
    found = ((number, label) for number, line in enumerate(lines, 1) for label in hygiene.line_problems(line))
    return tuple(itertools.islice(found, MAX_PROBLEMS + 1))


def _link_target(content: bytes) -> str | None:
    """The content as a link target: NUL-free UTF-8 of at most PATH_MAX bytes, or None."""
    if b"\x00" in content or len(content) > PATH_MAX:
        return None
    try:
        return content.decode("utf-8")
    except UnicodeDecodeError:
        return None


class _Blobs:
    """The blobs the commits add, each read once.

    A blob is read only within the file size limit, and all of them together only up to MAX_SCANNED_BYTES.
    """

    def __init__(self, workrepo: Path, megabytes: int) -> None:
        self._workrepo = workrepo
        self._megabytes = megabytes
        self._scanned = 0
        self._known: dict[str, _Blob] = {}

    def _read(self, sha: str) -> _Blob:
        limit = self._megabytes * MEGABYTE
        size = _number(run_git(self._workrepo, "cat-file", "-s", sha))
        if size > limit:
            return _Blob(too_large=True, findings=(), target=None)
        if self._scanned + size > MAX_SCANNED_BYTES:
            megabytes = MAX_SCANNED_BYTES // 1_000_000
            raise _Stop(9, f"the commits add more content than the factory checks ({megabytes} MB)")
        self._scanned += size
        content = run_git(self._workrepo, "cat-file", "blob", sha, max_output=limit + OUTPUT_MARGIN)
        return _Blob(too_large=False, findings=_findings(content), target=_link_target(content))

    def problems(self, entry: _Entry) -> list[str]:
        if entry.blob not in self._known:
            self._known[entry.blob] = self._read(entry.blob)
        blob = self._known[entry.blob]
        if blob.too_large:
            return [f"larger than {self._megabytes} MB"]
        if entry.mode != LINK_MODE:
            return [f"line {line}: {label}" for line, label in blob.findings]
        reasons = []
        if blob.target is None or _leaves(entry.path, blob.target):
            reasons.append("a link that leaves the repository")
        if blob.target is not None and _into_git(blob.target):
            reasons.append("a link into .git")
        labels = dict.fromkeys(label for _, label in blob.findings if label in CREDENTIAL_LABELS)
        return reasons + [f"a link whose target contains {label}" for label in labels]


def _entry_problems(entry: _Entry, config: Config, blobs: _Blobs) -> list[Problem]:
    """Checks 7 to 9 on one changed entry; a deleted entry is subject to check 7 only."""
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


def _judge_commits(workrepo: Path, commits: list[tuple[str, list[str]]], bot: Bot, config: Config,
                   problems: list[Problem]) -> None:
    """Checks 5 to 10 over the commits, oldest first.

    Problems go into `problems` as they are found, so that they survive a stop or a git failure further on.
    """
    identity = _identity(bot)
    entries: list[_Entry] = []
    for sha, parents in commits:
        problems.extend(_commit_problems(workrepo, sha, identity))
        if len(parents) == 1:
            entries.extend(_changes(workrepo, parents[0], sha))
            if len(entries) > MAX_ENTRIES:
                raise _Stop(10, TOO_MANY_FILES)
    blobs = _Blobs(workrepo, config.dispatcher.max_file_megabytes)
    for entry in entries:
        problems.extend(_entry_problems(entry, config, blobs))


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
    head, commits, problems = None, [], []
    try:
        head = _fetch(workrepo, path, branch, job_id, listed)
        commits = _commits_on_base(workrepo, base_sha, head, config.dispatcher.max_commits)
        _judge_commits(workrepo, commits, bot, config, problems)
    except _Stop as stop:
        problems.append(stop.problem)
    except (GitError, _Unreadable):
        problems.append((3, UNREADABLE))
    return _verdict(head, len(commits), problems)

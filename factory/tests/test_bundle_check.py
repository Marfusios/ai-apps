"""Tests for the bundle check: hostile bundles built with real git in temporary directories."""

import dataclasses
import itertools
import os
import random
import tempfile
import tracemalloc
import unittest
from collections.abc import Mapping
from pathlib import Path
from unittest import mock

from factory import bundle_check, gitops
from factory import config as factory_config
from factory.snapshot import Bot
from factory.tests.gitrepo import Repo, Tree, git

CONFIG = factory_config.load()
BOT = Bot("factory-test[bot]", 4242)
BRANCH = "factory/fix-12"
KEY = "sk-" + "a" * 24
LINK = "120000"
SUBMODULE = "160000"
GITMODULES = '[submodule "lib"]\n\tpath = lib\n\turl = https://example.com/lib.git\n'
MEGABYTE = 1024 * 1024
NOT_THE_BRANCH = "the bundle does not hold exactly the work branch"
UNREADABLE = "the bundle could not be read"
MALFORMED = "the job is malformed"
TOO_MANY_FILES = "the commits change more than 2,000 files"
FILES_TOO_LONG = "the commits change more than 2,000 files, or their paths are too long to check"
BASE_FILES = {"README.md": "# Demo\n", "apps/demo/a.txt": "old\n"}
BASE_LAYOUT = {"README.md": "# Demo\n", "apps": {"demo": {"a.txt": "old\n"}}}  # the same tree, nested


def limits(**changes: int) -> factory_config.Config:
    return dataclasses.replace(CONFIG, dispatcher=dataclasses.replace(CONFIG.dispatcher, **changes))


def merged(layout: Mapping, extra: Mapping) -> dict:
    """`layout` with the entries of `extra` added, directories merged."""
    result = dict(layout)
    for name, value in extra.items():
        both_directories = isinstance(value, Mapping) and isinstance(result.get(name), Mapping)
        result[name] = merged(result[name], value) if both_directories else value
    return result


REJECTED = [  # (name, commits, fragment one problem must contain, options for the commits, options for the check)
    ("protected path", [{"README.md": "x"}], "README.md, which is outside the writable paths", {}, {}),
    ("protected path then reverted", [{".github/workflows/x.yml": "on: push"}, {".github/workflows/x.yml": None}],
     "outside the writable paths", {}, {}),
    ("deleting a protected file", [{"apps/demo/a.txt": None, "README.md": None}],
     "README.md, which is outside the writable paths", {}, {}),
    ("credential then removed", [{"apps/demo/k.txt": KEY}, {"apps/demo/k.txt": None}], "possible provider key", {}, {}),
    ("credential file name", [{"apps/demo/.env": "A=1"}], "a credential file", {}, {}),
    ("credential in a file name", [{f"apps/demo/{KEY}.txt": "x"}], "a name that contains possible provider key",
     {}, {}),
    ("credential in a commit message", [{"apps/demo/a.txt": "new"}],
     "has a message or header that contains possible provider key", {"message": f"Fix it\n\nwith {KEY}"}, {}),
    ("submodule", [{"apps/demo/lib": "ab" * 20}], "apps/demo/lib: a submodule", {"mode": {"apps/demo/lib": SUBMODULE}},
     {}),
    ("submodule file", [{"apps/demo/.gitmodules": GITMODULES}], "apps/demo/.gitmodules: a submodule", {}, {}),
    ("link out of the repository", [{"apps/demo/link": "../../../etc/hostname"}],
     "apps/demo/link: a link that leaves the repository", {"mode": {"apps/demo/link": LINK}}, {}),
    ("absolute link", [{"apps/demo/link": "/etc/hostname"}], "a link that leaves the repository",
     {"mode": {"apps/demo/link": LINK}}, {}),
    ("link with a backslash", [{"apps/demo/link": "..\\..\\..\\etc"}], "a link that leaves the repository",
     {"mode": {"apps/demo/link": LINK}}, {}),
    ("link that climbs out through another link", [{"apps/demo/up": "..", "apps/demo/out": "up/../../.."}],
     "apps/demo/out: a link that leaves the repository", {"mode": {"apps/demo/up": LINK, "apps/demo/out": LINK}}, {}),
    ("credential as a link target", [{"apps/demo/link": KEY}],
     "apps/demo/link: a link whose target contains possible provider key", {"mode": {"apps/demo/link": LINK}}, {}),
    ("link into .git", [{"apps/demo/hook": "../../.git/hooks/pre-commit"}], "apps/demo/hook: a link into .git",
     {"mode": {"apps/demo/hook": LINK}}, {}),
    ("link into .git in another spelling", [{"apps/demo/hook": "../../.GIT./hooks/pre-commit"}], "a link into .git",
     {"mode": {"apps/demo/hook": LINK}}, {}),
    ("link into .git through a zero-width joiner", [{"apps/demo/hook": "../../.g‌it/hooks/pre-commit"}],
     "apps/demo/hook: a link that leaves the repository", {"mode": {"apps/demo/hook": LINK}}, {}),
    ("link into .git through a byte order mark", [{"apps/demo/hook": "../../.git﻿/hooks/pre-commit"}],
     "apps/demo/hook: a link that leaves the repository", {"mode": {"apps/demo/hook": LINK}}, {}),
    ("credential before an invalid byte", [{"apps/demo/k.bin": KEY.encode() + b"\xff"}],
     "apps/demo/k.bin: line 1: possible provider key", {}, {}),
    ("credential among NUL bytes", [{"apps/demo/k.bin": b"\x00\x01" + KEY.encode() + b"\x00"}],
     "apps/demo/k.bin: line 1: possible provider key", {}, {}),
    ("credential split by a control character the bot removes", [{"apps/demo/k.txt": KEY[:10] + "\x1c" + KEY[10:]}],
     "apps/demo/k.txt: line 1: possible provider key", {}, {}),
    ("oversized file", [{"apps/demo/big.bin": b"x" * (MEGABYTE * 3 // 2)}], "apps/demo/big.bin: larger than 1 MB", {},
     {"config": limits(max_file_megabytes=1)}),
]

HOME = "home"  # joined at run time: the repository checker refuses the literal path shape, as it should
ACCEPTED = [  # (name, commits, options for the commits)
    ("a home directory inside an app", [{f"apps/demo/src/{HOME}/sections/hero.tsx": "export const hero = 1;\n"}],
     {}),
    ("a link through a home directory", [{"apps/demo/x/logo": f"../src/{HOME}/img/logo.png"}],
     {"mode": {"apps/demo/x/logo": LINK}}),
    ("links that stay inside",
     [{"apps/demo/b.txt": "b", "apps/demo/same": "b.txt", "apps/demo/sibling": "../other/x.txt",
       "apps/demo/sub/up": "../../../packages/p/y"}],
     {"mode": {"apps/demo/same": LINK, "apps/demo/sibling": LINK, "apps/demo/sub/up": LINK}}),
    ("deleting a writable file", [{"apps/demo/b.txt": "b"}, {"apps/demo/a.txt": None}], {}),
]

BOT_IDENT = f"{BOT.login} <{BOT.email}> 1764230400 +0000"
VICTIM_IDENT = "Victim Person <victim@example.com> 1764230400 +0000"
PLAIN_HEADERS = ["tree {tree}", "parent {parent}", f"author {BOT_IDENT}", f"committer {BOT_IDENT}"]
NOT_AUTHORED = "is not authored by the factory's identity"
OTHER_HEADERS = "has headers the factory does not write"
FORGED = [  # (name, header lines, message, fragment): commit objects written by hand, as an attacker could
    ("a second author after the committer",
     ["tree {tree}", "parent {parent}", f"author {VICTIM_IDENT}", f"committer {BOT_IDENT}", f"author {BOT_IDENT}"],
     "change", NOT_AUTHORED),
    ("a second committer",
     ["tree {tree}", "parent {parent}", f"author {BOT_IDENT}", f"committer {VICTIM_IDENT}", f"committer {BOT_IDENT}"],
     "change", NOT_AUTHORED),
    ("an ident with a third bracket",
     ["tree {tree}", "parent {parent}", f"author {BOT.login} <{BOT.email}> <victim@example.com> 1764230400 +0000",
      f"committer {BOT_IDENT}"], "change", NOT_AUTHORED),
    ("a signature", PLAIN_HEADERS + ["gpgsig -----BEGIN PGP SIGNATURE-----", " iQEzBAABCAAdFiEE", " =abcd",
                                     " -----END PGP SIGNATURE-----"], "change", OTHER_HEADERS),
    ("no author line", ["tree {tree}", "parent {parent}", f"committer {BOT_IDENT}"], "change", NOT_AUTHORED),
    ("a zero-padded date", ["tree {tree}", "parent {parent}", f"author {BOT.login} <{BOT.email}> 0123 +0000",
                            f"committer {BOT_IDENT}"], "change", NOT_AUTHORED),
    ("a date longer than git reads", ["tree {tree}", "parent {parent}", f"author {BOT_IDENT}",
                                      f"committer {BOT.login} <{BOT.email}> {'1' * 17} +0000"], "change",
     NOT_AUTHORED),
    ("an encoding", PLAIN_HEADERS + ["encoding ISO-8859-1"], "change", OTHER_HEADERS),
    ("an unknown header", PLAIN_HEADERS + ["x-note hello"], "change", OTHER_HEADERS),
    ("a repeated author line", PLAIN_HEADERS + [f"author {BOT_IDENT}"], "change", OTHER_HEADERS),
    ("a commit larger than a commit may be", PLAIN_HEADERS, "x" * 100_001, "is larger than a commit may be"),
]
# Rows that git 2.46 and later can refuse while fetching, before these checks see them: the fsck that applies
# then refuses a link into .git, a date that is not a number, is zero-padded or overflows, and a commit without an
# author.
GIT_MAY_REFUSE = {"link into .git", "link into .git in another spelling",
                  "link into .git through a zero-width joiner", "link into .git through a byte order mark",
                  "an ident with a third bracket", "no author line", "a zero-padded date", "a date longer than git reads"}


class BundleCheckTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.numbers = itertools.count(1)
        self.work = Repo(self.tmp / "work")
        self.base = self.work.commit(BASE_FILES)
        self.mirror = self.work.bare_clone(self.tmp / "mirror.git")
        self.workrepo = self.tmp / "workrepo.git"
        gitops.ensure_workrepo(self.workrepo, self.mirror)

    def fresh(self, stem: str) -> Path:
        return self.tmp / f"{stem}-{next(self.numbers)}"

    def job_id(self) -> str:
        return f"20260101T120000Z-fix_issue-12-{next(self.numbers):08x}"

    def bot_commit(self, files, **options) -> str:
        return self.work.commit(files, **{"name": BOT.login, "email": BOT.email, **options})

    def bundle_of(self, *commits, **options) -> Path:
        """Commits on the work branch from main, as the bot unless `options` say otherwise."""
        self.work.switch(BRANCH, self.base)
        for files in commits:
            self.bot_commit(files, **options)
        return self.work.bundle(self.base, BRANCH, self.fresh("bundle"))

    def bundle_of_tree(self, extra: Mapping) -> Path:
        """One bot commit whose tree is the base's with `extra` added, written with `git mktree`."""
        self.work.switch(BRANCH, self.base)
        self.work.commit_tree(self.work.tree(merged(BASE_LAYOUT, extra)), [self.base], name=BOT.login,
                              email=BOT.email)
        return self.work.bundle(self.base, BRANCH, self.fresh("bundle"))

    def bundle_with(self, *revisions: str) -> Path:
        out = self.fresh("bundle")
        self.work.git("bundle", "create", str(out), *revisions)
        return out

    def check(self, bundle: Path, **overrides) -> bundle_check.Verdict:
        arguments = {"workrepo": self.workrepo, "base_sha": self.base, "branch": BRANCH, "job_id": self.job_id(),
                     "bot": BOT, "config": CONFIG}
        return bundle_check.check(bundle, **{**arguments, **overrides})

    def assertRejected(self, verdict: bundle_check.Verdict, fragment: str | None = None) -> None:
        self.assertFalse(verdict.ok, verdict)
        self.assertTrue(verdict.problems, verdict)
        if fragment is not None:
            self.assertTrue(any(fragment in problem for problem in verdict.problems), verdict.problems)

    def test_a_clean_bundle_passes(self):
        verdict = self.check(self.bundle_of({"apps/demo/a.txt": "new"}))
        self.assertTrue(verdict.ok)
        self.assertEqual(verdict.commits, 1)
        self.assertEqual(verdict.head_sha, self.work.head)
        self.assertEqual(verdict.problems, ())

    def test_acceptances(self):
        for name, commits, commit_options in ACCEPTED:
            with self.subTest(name):
                verdict = self.check(self.bundle_of(*commits, **commit_options))
                self.assertEqual((verdict.ok, verdict.problems, verdict.commits), (True, (), len(commits)))

    def test_forged_commit_objects_are_rejected(self):
        tree = self.work.tree(merged(BASE_LAYOUT, {"apps": {"demo": {"a.txt": "new\n"}}}))

        def forged(headers: list[str], message: str = "change") -> Path:
            self.work.switch(BRANCH, self.base)
            self.work.raw_commit([line.format(tree=tree, parent=self.base) for line in headers], message)
            return self.work.bundle(self.base, BRANCH, self.fresh("bundle"))

        self.assertEqual(self.check(forged(PLAIN_HEADERS)).problems, ())  # written by hand just as git writes it
        at_the_epoch = [line.replace("1764230400", "0") for line in PLAIN_HEADERS]
        self.assertEqual(self.check(forged(at_the_epoch)).problems, ())
        for name, headers, message, fragment in FORGED:
            with self.subTest(name):
                verdict = self.check(forged(headers, message))
                if name in GIT_MAY_REFUSE and verdict.problems == (UNREADABLE,):
                    continue
                self.assertRejected(verdict, f"commit {self.work.head[:12]} {fragment}")

    def test_the_fetched_head_stays_in_quarantine_and_a_second_check_of_the_same_job_agrees(self):
        bundle = self.bundle_of({"apps/demo/a.txt": "new"})
        job_id = self.job_id()
        first = self.check(bundle, job_id=job_id)
        self.assertEqual(gitops.resolve(self.workrepo, f"refs/quarantine/{job_id}"), self.work.head)
        self.assertEqual(self.check(bundle, job_id=job_id), first)

    def test_rejections(self):
        for name, commits, fragment, commit_options, check_options in REJECTED:
            with self.subTest(name):
                verdict = self.check(self.bundle_of(*commits, **commit_options), **check_options)
                if name in GIT_MAY_REFUSE and verdict.problems == (UNREADABLE,):
                    continue
                self.assertRejected(verdict, fragment)

    def test_trees_git_itself_would_not_build_are_rejected(self):
        oddities = {
            "a .GIT directory": {".GIT": {"config": "[core]\n"}},
            "an entry named ..": {"..": "x"},
            "an entry named .": {".": "x"},
            "an NTFS alias of .git": {".git.": {"config": "[core]\n"}},
            "an NTFS short name of .git": {"git~1": {"config": "[core]\n"}},
            "a control character": {"a\x01b": "x"},
            "a backslash that climbs out": {"x\\..\\..\\..\\README.md": "x"},
        }
        for name, oddity in oddities.items():
            with self.subTest(name):
                verdict = self.check(self.bundle_of_tree({"apps": {"demo": oddity}}))
                self.assertFalse(verdict.ok)
                # Newer git refuses some of these while fetching; where it does not, the path check must.
                if verdict.problems != (UNREADABLE,):
                    self.assertRejected(verdict, "which is outside the writable paths")

    def test_a_commit_by_someone_else_is_rejected(self):
        someone = ("Someone", "someone@example.com")
        cases = {
            "foreign committer": {"committer": someone},
            "foreign author": {"name": someone[0], "email": someone[1], "committer": (BOT.login, BOT.email)},
            "the bot's name with another email": {"email": someone[1]},
        }
        for name, options in cases.items():
            with self.subTest(name):
                verdict = self.check(self.bundle_of({"apps/demo/a.txt": "new"}, **options))
                self.assertRejected(verdict, f"commit {self.work.head[:12]} is not authored by the factory's identity")

    def test_a_merge_commit_is_rejected(self):
        self.work.switch("side", self.base)
        side = self.bot_commit({"apps/demo/side.txt": "side"})
        self.work.switch(BRANCH, self.base)
        line = self.bot_commit({"apps/demo/a.txt": "new"})
        merge = self.work.commit_tree(self.work.git("write-tree"), [line, side], name=BOT.login, email=BOT.email)
        verdict = self.check(self.work.bundle(self.base, BRANCH, self.fresh("bundle")))
        self.assertRejected(verdict, f"commit {merge[:12]} is a merge")
        self.assertEqual(verdict.commits, 3)

    def test_a_bundle_based_elsewhere_is_rejected(self):
        self.work.switch(BRANCH, self.base)
        self.work.commit_tree(self.work.tree({"apps": {"demo": {"a.txt": "other"}}}), [], name=BOT.login,
                              email=BOT.email)
        self.bot_commit({"apps/demo/b.txt": "b"})
        verdict = self.check(self.work.bundle(self.base, BRANCH, self.fresh("bundle")))
        self.assertEqual(verdict.problems, ("the commits do not sit on top of the expected base",))
        self.assertEqual(verdict.head_sha, self.work.head)

    def test_a_bundle_with_two_heads_or_another_branch_is_rejected(self):
        self.work.switch("other", self.base)
        self.bot_commit({"apps/demo/o.txt": "o"})
        self.bundle_of({"apps/demo/a.txt": "new"})
        self.work.git("tag", "v1")
        cases = {
            "two branches": self.bundle_with(f"^{self.base}", f"refs/heads/{BRANCH}", "refs/heads/other"),
            "the branch and a tag": self.bundle_with(f"^{self.base}", f"refs/heads/{BRANCH}", "refs/tags/v1"),
            "the branch and HEAD": self.bundle_with(f"^{self.base}", f"refs/heads/{BRANCH}", "HEAD"),
            "only main": self.bundle_with("refs/heads/main"),
            "only another branch": self.bundle_with(f"^{self.base}", "refs/heads/other"),
        }
        for name, bundle in cases.items():
            with self.subTest(name):
                verdict = self.check(bundle)
                self.assertEqual((verdict.ok, verdict.head_sha, verdict.problems), (False, None, (NOT_THE_BRANCH,)))
        with self.subTest("the work branch of another issue"):
            verdict = self.check(self.bundle_with(f"^{self.base}", f"refs/heads/{BRANCH}"), branch="factory/fix-13")
            self.assertEqual(verdict.problems, (NOT_THE_BRANCH,))

    def test_an_empty_or_garbage_file_is_rejected_without_an_exception(self):
        real = self.bundle_of({"apps/demo/a.txt": "new"}).read_bytes()
        header = f"# v2 git bundle\n{self.work.head} refs/heads/{BRANCH}\n\n".encode()
        directory = self.fresh("directory")
        directory.mkdir()
        cases = {
            "a missing file": (self.fresh("absent"), None),
            "a directory": (directory, None),
            "an empty file": (self.fresh("empty"), b""),
            "garbage": (self.fresh("garbage"), bytes(range(256)) * 64),
            "a header over garbage": (self.fresh("header"), header + b"PACK" + b"\xff" * 512),
            "a truncated bundle": (self.fresh("truncated"), real[: len(real) // 2]),
        }
        for name, (path, content) in cases.items():
            with self.subTest(name):
                if content is not None:
                    path.write_bytes(content)
                verdict = self.check(path)
                self.assertRejected(verdict)
                self.assertEqual(verdict.commits, 0)

    @unittest.skipUnless(hasattr(os, "symlink"), "this platform has no symbolic links")
    def test_a_bundle_behind_a_symbolic_link_is_rejected(self):
        link = self.fresh("link")
        try:
            os.symlink(self.bundle_of({"apps/demo/a.txt": "new"}), link)
        except OSError:
            self.skipTest("creating symbolic links is not permitted here")
        self.assertEqual(self.check(link).problems, ("the bundle is missing or larger than 50 MB",))

    def test_too_many_commits_and_too_large_a_bundle_are_rejected(self):
        with self.subTest("too many commits"):
            bundle = self.bundle_of({"apps/demo/a.txt": "1"}, {"apps/demo/a.txt": "2"}, {"apps/demo/a.txt": "3"})
            verdict = self.check(bundle, config=limits(max_commits=2))
            self.assertEqual(verdict.problems, ("there are more than 2 commits",))
            self.assertEqual(verdict.head_sha, self.work.head)
        with self.subTest("too large a bundle"):
            noise = random.Random(8).randbytes(MEGABYTE * 3 // 2)
            verdict = self.check(self.bundle_of({"apps/demo/noise.bin": noise}), config=limits(max_bundle_megabytes=1))
            self.assertEqual(verdict.problems, ("the bundle is missing or larger than 1 MB",))
            self.assertIsNone(verdict.head_sha)
        with self.subTest("no commits"):
            self.work.switch(BRANCH, self.base)
            verdict = self.check(self.bundle_with(f"refs/heads/{BRANCH}"))
            self.assertEqual(verdict.problems, ("there are no commits",))

    def test_more_than_two_thousand_changed_files_are_rejected(self):
        files = {f"apps/demo/many/{number}.txt": "same" for number in range(2001)}
        verdict = self.check(self.bundle_of(files))
        self.assertEqual(verdict.problems, (TOO_MANY_FILES,))

    def test_a_tiny_bundle_of_shared_trees_with_many_paths_is_rejected_without_reading_them_all(self):
        leaf = self.work.tree({f"f{number}": "x" for number in range(60)})
        middle = self.work.tree({f"d{number}": Tree(leaf) for number in range(60)})
        top = self.work.tree({f"d{number}": Tree(middle) for number in range(60)})  # 216,000 paths
        bundle = self.bundle_of_tree({"apps": {"demo": {"wide": Tree(top)}}})
        self.assertLess(bundle.stat().st_size, 100_000)
        tracemalloc.start()
        try:
            verdict = self.check(bundle)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(verdict.problems, (FILES_TOO_LONG,))
        self.assertLess(peak, 20 * MEGABYTE)  # git would print about 27 MB of entries if it were let

    def test_an_octopus_commit_too_long_to_list_is_not_counted_as_many_commits(self):
        self.work.switch("chain", self.base)
        chain = [self.base] + [self.bot_commit({"apps/demo/a.txt": f"{number}\n"}) for number in range(6)]
        git(f"--git-dir={self.mirror}", "fetch", "-q", str(self.work.path), "refs/heads/chain:refs/heads/chain")
        self.work.switch(BRANCH, chain[-1])
        self.work.commit_tree(self.work.git("write-tree"), list(reversed(chain)), name=BOT.login, email=BOT.email)
        bundle = self.work.bundle(chain[-1], BRANCH, self.fresh("bundle"))
        verdict = self.check(bundle, base_sha=chain[-1], config=limits(max_commits=1))  # one commit, seven parents
        self.assertEqual(verdict.problems, ("the list of commits is too long to check",))

    def test_a_path_too_long_to_list_is_not_counted_as_many_files(self):
        verdict = self.check(self.bundle_of_tree({"apps": {"demo": {"x" * (9 * MEGABYTE): "x"}}}))
        self.assertFalse(verdict.ok)
        # Newer git may refuse so long a name while fetching; where it does not, the cap on git's output must.
        if verdict.problems != (UNREADABLE,):
            self.assertEqual(verdict.problems, (FILES_TOO_LONG,))

    def test_content_beyond_what_the_factory_scans_stops_the_check(self):
        bundle = self.bundle_of({"apps/demo/one.txt": "12345678", "apps/demo/two.txt": "abcdefgh"})
        with mock.patch.object(bundle_check, "MAX_SCANNED_BYTES", 10):
            verdict = self.check(bundle)
        self.assertRejected(verdict, "the commits add more content than the factory checks")
        self.assertEqual(self.check(bundle).problems, ())

    def test_problems_never_quote_file_contents(self):
        bundle = self.bundle_of({
            "apps/demo/k.txt": f"first line\nkey = {KEY}\n",
            "README.md": f"{KEY}\n",
            "apps/demo/.env": f"KEY={KEY}\n",
            f"docs/{KEY}.txt": "x",
        })
        verdict = self.check(bundle)
        self.assertRejected(verdict, "apps/demo/k.txt: line 2: possible provider key")
        self.assertRejected(verdict, "a path that is not shown, which is outside the writable paths")
        for problem in verdict.problems:
            self.assertNotIn(KEY, problem)
            self.assertNotIn("first line", problem)

    def test_paths_are_shown_in_printable_ascii_and_cut_short(self):
        verdict = self.check(self.bundle_of_tree({"docs": {"café\x1b[1m.txt": "x"}}))
        self.assertRejected(verdict, "changes docs/caf??[1m.txt, which is outside")
        long_name = "docs/" + "x" * 300
        verdict = self.check(self.bundle_of({long_name: "x"}))
        self.assertRejected(verdict, f"changes {long_name[:200]}, which is outside")
        self.assertFalse(any(long_name[:201] in problem for problem in verdict.problems))

    def test_problems_are_kept_to_twenty_and_the_rest_are_counted(self):
        verdict = self.check(self.bundle_of({f"docs/{number:02}.txt": "x" for number in range(25)}))
        self.assertEqual(len(verdict.problems), 21)
        self.assertEqual(verdict.problems[-1], "and 5 more")

    def test_problems_come_in_the_order_of_the_checks(self):
        bundle = self.bundle_of({"apps/demo/k.txt": KEY, "README.md": "x"}, {"apps/demo/.env": "A=1"},
                                committer=("Someone", "someone@example.com"))
        problems = self.check(bundle).problems
        order = ["is not authored", "outside the writable paths", "a credential file", "possible provider key"]
        positions = [next(index for index, problem in enumerate(problems) if part in problem) for part in order]
        self.assertEqual(positions, sorted(positions), problems)

    def test_a_malformed_job_fails_without_raising(self):
        bundle = self.bundle_of({"apps/demo/a.txt": "new"})
        cases = {
            "job id": {"job_id": "../20260101T120000Z-fix_issue-12-0a1b2c3d"},
            "job id that is not text": {"job_id": None},
            "branch that is an option": {"branch": "-f"},
            "branch outside factory/": {"branch": "main"},
            "branch that climbs": {"branch": "factory/../main"},
            "branch with a refspec": {"branch": "factory/fix-12:refs/heads/main"},
            "branch that is not text": {"branch": 12},
            "short base": {"base_sha": self.base[:12]},
            "upper-case base": {"base_sha": self.base.upper()},
            "base that is an option": {"base_sha": "-" + self.base[1:]},
            "base that is a name": {"base_sha": "HEAD"},
        }
        for name, overrides in cases.items():
            with self.subTest(name):
                self.assertEqual(self.check(bundle, **overrides), bundle_check.Verdict(False, None, 0, (MALFORMED,)))


if __name__ == "__main__":
    unittest.main()

"""Tests for the bundle check: hostile bundles built with real git in temporary directories."""

import dataclasses
import itertools
import os
import random
import tempfile
import unittest
from collections.abc import Mapping
from pathlib import Path

from factory import bundle_check, gitops
from factory import config as factory_config
from factory.snapshot import Bot
from factory.tests.gitrepo import Repo

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
    ("credential as a link target", [{"apps/demo/link": KEY}], "apps/demo/link: line 1: possible provider key",
     {"mode": {"apps/demo/link": LINK}}, {}),
    ("oversized file", [{"apps/demo/big.bin": b"x" * (MEGABYTE * 3 // 2)}], "apps/demo/big.bin: larger than 1 MB", {},
     {"config": limits(max_file_megabytes=1)}),
]


class BundleCheckTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.numbers = itertools.count(1)
        self.work = Repo(self.tmp / "work")
        self.base = self.work.commit(BASE_FILES)
        mirror = self.work.bare_clone(self.tmp / "mirror.git")
        self.workrepo = self.tmp / "workrepo.git"
        gitops.ensure_workrepo(self.workrepo, mirror)

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

    def test_links_that_stay_inside_and_deletions_of_writable_files_pass(self):
        bundle = self.bundle_of(
            {"apps/demo/b.txt": "b", "apps/demo/same": "b.txt", "apps/demo/sibling": "../other/x.txt",
             "apps/demo/sub/up": "../../../packages/p/y"},
            {"apps/demo/a.txt": None},
            mode={"apps/demo/same": LINK, "apps/demo/sibling": LINK, "apps/demo/sub/up": LINK},
        )
        verdict = self.check(bundle)
        self.assertEqual(verdict.problems, ())
        self.assertEqual(verdict.commits, 2)

    def test_the_fetched_head_stays_in_quarantine_and_a_second_check_of_the_same_job_agrees(self):
        bundle = self.bundle_of({"apps/demo/a.txt": "new"})
        job_id = self.job_id()
        first = self.check(bundle, job_id=job_id)
        self.assertEqual(gitops.resolve(self.workrepo, f"refs/quarantine/{job_id}"), self.work.head)
        self.assertEqual(self.check(bundle, job_id=job_id), first)

    def test_rejections(self):
        for name, commits, fragment, commit_options, check_options in REJECTED:
            with self.subTest(name):
                self.assertRejected(self.check(self.bundle_of(*commits, **commit_options), **check_options), fragment)

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
        self.assertEqual(verdict.problems, ("the commits change more than 2,000 files",))

    def test_problems_never_quote_file_contents(self):
        personal = "apps/demo/" + "home" + "/someone/notes.txt"
        bundle = self.bundle_of({
            "apps/demo/k.txt": f"first line\nkey = {KEY}\n",
            "README.md": f"{KEY}\n",
            "apps/demo/.env": f"KEY={KEY}\n",
            f"docs/{KEY}.txt": "x",
            personal: "x",
        })
        verdict = self.check(bundle)
        self.assertRejected(verdict, "apps/demo/k.txt: line 2: possible provider key")
        self.assertRejected(verdict, "a path that is not shown, which is outside the writable paths")
        for problem in verdict.problems:
            self.assertNotIn(KEY, problem)
            self.assertNotIn("first line", problem)
            self.assertNotIn("someone", problem)

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

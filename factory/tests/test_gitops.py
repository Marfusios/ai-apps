"""Tests for the dispatcher's git: the mirror, the work repository, resolving refs and pushing."""

import base64
import os
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from factory import gitops
from factory.gitops import GitError, GitOutputTooLarge
from factory.tests.gitrepo import Repo, git

BRANCH = "factory/fix-12"
TOKEN = "token-" + "x" * 20
URL = "https://example.com/owner/repo.git"
MEGABYTE = 1024 * 1024


class FakeProcess:
    """Stands in for `subprocess.Popen`: a git that prints nothing and succeeds, or one that hangs until stopped."""

    def __init__(self, *, hangs: bool = False) -> None:
        self.stdin = None
        self.stdout = self
        self.returncode: int | None = None
        self.killed = threading.Event()
        self._hangs = hangs

    def read(self, size: int = -1) -> bytes:
        if self._hangs:
            self.killed.wait()
        return b""

    def kill(self) -> None:
        self.killed.set()

    def wait(self, timeout: float | None = None) -> int:
        self.returncode = -9 if self.killed.is_set() else 0
        return self.returncode

    def poll(self) -> int | None:
        return self.returncode

    def __enter__(self) -> "FakeProcess":
        return self

    def __exit__(self, *exception: object) -> None:
        return None


class GitopsTestCase(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.upstream = Repo(self.tmp / "upstream")
        self.main = self.upstream.commit({"apps/demo/a.txt": "old"})

    def symbolic_head(self, repo: Path) -> str:
        return git(f"--git-dir={repo}", "symbolic-ref", "HEAD")

    def work_repository(self) -> tuple[Path, Path]:
        """A bare remote cloned from upstream, a mirror of it and a work repository beside the mirror."""
        remote = self.upstream.bare_clone(self.tmp / "remote.git")
        mirror = self.tmp / "mirror.git"
        gitops.ensure_mirror(mirror, str(remote), TOKEN)
        workrepo = self.tmp / "workrepo.git"
        gitops.ensure_workrepo(workrepo, mirror)
        return remote, workrepo

    def take(self, workrepo: Path, name: str) -> None:
        """Bring the upstream work branch into the work repository, as a checked bundle would be."""
        gitops.run_git(workrepo, "fetch", "--", str(self.upstream.path), f"refs/heads/{BRANCH}:refs/quarantine/{name}")

    def test_ensure_mirror_fetches_branches_and_points_head_at_main(self):
        self.upstream.switch(BRANCH)
        work = self.upstream.commit({"apps/demo/a.txt": "new"})
        mirror = self.tmp / "mirror.git"
        gitops.ensure_mirror(mirror, str(self.upstream.path), TOKEN)
        self.assertEqual(gitops.resolve(mirror, "refs/heads/main"), self.main)
        self.assertEqual(gitops.resolve(mirror, f"refs/heads/{BRANCH}"), work)
        self.assertEqual(self.symbolic_head(mirror), "refs/heads/main")

        self.upstream.git("update-ref", "-d", f"refs/heads/{BRANCH}")
        gitops.ensure_mirror(mirror, str(self.upstream.path), TOKEN)
        self.assertIsNone(gitops.resolve(mirror, f"refs/heads/{BRANCH}"))
        self.assertEqual(gitops.resolve(mirror, "refs/heads/main"), self.main)

    def test_ensure_workrepo_borrows_the_mirrors_objects_and_can_be_called_again(self):
        mirror = self.upstream.bare_clone(self.tmp / "mirror.git")
        workrepo = self.tmp / "workrepo.git"
        gitops.ensure_workrepo(workrepo, mirror)
        gitops.ensure_workrepo(workrepo, mirror)
        alternates = (workrepo / "objects" / "info" / "alternates").read_text(encoding="utf-8").splitlines()
        self.assertEqual([Path(line) for line in alternates], [(mirror / "objects").absolute()])
        self.assertEqual(gitops.run_git(workrepo, "cat-file", "-t", self.main), b"commit\n")
        self.assertIsNone(gitops.resolve(workrepo, "refs/heads/main"))  # objects are shared, refs are not

    def test_resolve(self):
        mirror = self.upstream.bare_clone(self.tmp / "mirror.git")
        self.assertEqual(gitops.resolve(mirror, "refs/heads/main"), self.main)
        self.assertEqual(gitops.resolve(mirror, "main"), self.main)
        self.assertIsNone(gitops.resolve(mirror, "refs/heads/absent"))
        self.assertIsNone(gitops.resolve(mirror, "--all"))
        with self.assertRaises(GitError):
            gitops.resolve(self.tmp / "not-a-repository.git", "refs/heads/main")

    def test_push_fast_forwards_a_factory_branch(self):
        remote, workrepo = self.work_repository()
        self.upstream.switch(BRANCH)
        first = self.upstream.commit({"apps/demo/a.txt": "first"})
        self.take(workrepo, "one")
        gitops.push(workrepo, str(remote), TOKEN, first, BRANCH)
        self.assertEqual(gitops.resolve(remote, f"refs/heads/{BRANCH}"), first)

        second = self.upstream.commit({"apps/demo/a.txt": "second"})
        self.take(workrepo, "two")
        gitops.push(workrepo, str(remote), TOKEN, second, BRANCH)
        self.assertEqual(gitops.resolve(remote, f"refs/heads/{BRANCH}"), second)
        self.assertEqual(gitops.resolve(remote, "refs/heads/main"), self.main)

    def test_push_refuses_other_branches_and_never_forces(self):
        remote, workrepo = self.work_repository()
        sha = self.main
        refused = [(sha, branch) for branch in (
            "main", "factory/", "factory/../main", "factory/fix-12:refs/heads/main", "refs/heads/factory/fix-12",
            "+factory/fix-12", "-f", "factory/-fix", "Factory/fix-12", "factory/Fix-12", "factory/fix 12",
            "factory/fix-12\n", "factory/a/b", "factory/" + "x" * 62, None,
        )] + [(bad, BRANCH) for bad in ("HEAD", "+" + sha, sha.upper(), sha[:39], "-" + sha[1:], sha + "\n", None)]
        with mock.patch("factory.gitops.subprocess.Popen") as popen:
            for bad_sha, branch in refused:
                with self.subTest(sha=bad_sha, branch=branch), self.assertRaises(GitError) as raised:
                    gitops.push(workrepo, str(remote), TOKEN, bad_sha, branch)
                self.assertEqual(raised.exception.subcommand, "push")
            popen.assert_not_called()

        self.upstream.switch(BRANCH)
        pushed = self.upstream.commit({"apps/demo/a.txt": "pushed"})
        self.take(workrepo, "one")
        self.upstream.switch(BRANCH, self.main)
        sibling = self.upstream.commit({"apps/demo/a.txt": "sibling"})
        self.take(workrepo, "two")

        calls = []
        real_popen = subprocess.Popen

        def recording(argv, **options):
            calls.append(argv)
            return real_popen(argv, **options)

        with mock.patch("factory.gitops.subprocess.Popen", side_effect=recording):
            gitops.push(workrepo, str(remote), TOKEN, pushed, BRANCH)
            with self.assertRaises(GitError):
                gitops.push(workrepo, str(remote), TOKEN, sibling, BRANCH)
        self.assertEqual(gitops.resolve(remote, f"refs/heads/{BRANCH}"), pushed)
        for argv in calls:
            arguments = argv[argv.index("push") + 1:]
            self.assertFalse({"--force", "-f", "--force-with-lease", "--mirror"} & set(arguments), argv)
            self.assertFalse(any(argument.startswith("+") for argument in arguments), argv)
            self.assertIn(arguments[-1], (f"{pushed}:refs/heads/{BRANCH}", f"{sibling}:refs/heads/{BRANCH}"))

    def test_the_token_reaches_git_through_the_environment_only(self):
        calls = []

        def answer(argv, **options):
            calls.append((argv, options))
            return FakeProcess()

        inherited = {"GIT_DIR": str(self.tmp / "elsewhere"), "GIT_SSH_COMMAND": "ssh -o x", "git_trace": "1"}
        with mock.patch.dict(os.environ, inherited), mock.patch("factory.gitops.subprocess.Popen", side_effect=answer):
            gitops.ensure_mirror(self.tmp / "mirror.git", URL, TOKEN)
            gitops.push(self.tmp / "workrepo.git", URL, TOKEN, self.main, BRANCH)
        header = "Authorization: Basic " + base64.b64encode(f"x-access-token:{TOKEN}".encode()).decode()
        self.assertEqual(sum(1 for argv, _ in calls if {"fetch", "push"} & set(argv)), 2)
        for argv, options in calls:
            env = options["env"]
            self.assertFalse(any(TOKEN in argument for argument in argv), argv)
            self.assertFalse({"GIT_DIR", "GIT_SSH_COMMAND", "GIT_TRACE"} & {name.upper() for name in env})
            self.assertEqual((env["GIT_TERMINAL_PROMPT"], env["GIT_CONFIG_NOSYSTEM"], env["GIT_CONFIG_GLOBAL"]),
                             ("0", "1", os.devnull))
            self.assertEqual((options["stdin"], options["stderr"]), (subprocess.DEVNULL, subprocess.DEVNULL))
            if {"fetch", "push"} & set(argv):
                self.assertEqual((env["GIT_CONFIG_COUNT"], env["GIT_CONFIG_KEY_0"], env["GIT_CONFIG_VALUE_0"]),
                                 ("1", "http.extraHeader", header))
            else:
                self.assertNotIn("GIT_CONFIG_COUNT", env)

    def test_a_git_error_names_the_command_and_how_it_ended_but_nothing_else(self):
        missing = self.tmp / "missing.git"
        with self.assertRaises(GitError) as raised:
            gitops.run_git(missing, "-c", "fetch.fsckObjects=true", "fetch", "--", URL, token=TOKEN)
        error = raised.exception
        self.assertEqual((error.subcommand, error.status), ("fetch", 128))
        self.assertEqual(str(error), "git fetch failed: exit status 128")
        self.assertIsNone(error.__context__)

    def test_a_git_that_hangs_is_stopped_at_its_timeout(self):
        hanging = FakeProcess(hangs=True)
        started = time.monotonic()
        with (mock.patch("factory.gitops.subprocess.Popen", return_value=hanging),
              self.assertRaises(GitError) as raised):
            gitops.run_git(self.tmp / "repo.git", "push", "--", URL, token=TOKEN, timeout=1)
        self.assertLess(time.monotonic() - started, 30)
        self.assertTrue(hanging.killed.is_set())
        self.assertEqual(str(raised.exception), "git push failed: timeout")
        self.assertIsNone(raised.exception.__cause__)
        self.assertTrue(raised.exception.__suppress_context__)

    def test_output_past_the_limit_stops_git_promptly(self):
        gitdir = self.upstream.path / ".git"
        blob = self.upstream.blob(b"x" * MEGABYTE)
        requests = f"{blob}\n".encode() * 10_000  # ten gigabytes of answers if nothing stopped git
        started = time.monotonic()
        with self.assertRaises(GitOutputTooLarge) as raised:
            gitops.run_git(gitdir, "cat-file", "--batch", input=requests, max_output=100_000)
        self.assertLess(time.monotonic() - started, 30)
        self.assertIsInstance(raised.exception, GitError)
        self.assertEqual(str(raised.exception), "git cat-file failed: more than 100000 bytes of output")

    def test_output_within_the_limit_is_returned_whole(self):
        gitdir = self.upstream.path / ".git"
        output = gitops.run_git(gitdir, "hash-object", "--stdin", input=b"some content", max_output=41)
        self.assertEqual(output, f"{self.upstream.blob(b'some content')}\n".encode())


if __name__ == "__main__":
    unittest.main()

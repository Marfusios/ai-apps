"""Tests for the credential, personal path and private address patterns shared with the checker."""

import unittest
from pathlib import PurePosixPath

from factory import hygiene


class LineProblemTests(unittest.TestCase):
    def test_line_problems(self) -> None:
        key = "sk-" + "a" * 24
        private = ".".join(["192", "168", "1", "20"])
        self.assertEqual(hygiene.line_problems(f"token {key}"), ["possible provider key"])
        self.assertEqual(hygiene.line_problems(f"{private} and {private}"), ["private network address"])
        self.assertEqual(hygiene.line_problems("8.8.8.8 is public"), [])

    def test_labels_follow_the_pattern_order_then_the_address(self) -> None:
        key = "sk-" + "a" * 24
        home = "/" + "home" + "/someone/x"
        private = ".".join(["10", "0", "0", "5"])
        self.assertEqual(
            hygiene.line_problems(f"{private} {home} {key}"),
            ["possible provider key", "personal filesystem path", "private network address"],
        )

    def test_a_malformed_address_is_not_a_problem(self) -> None:
        self.assertEqual(hygiene.line_problems("version 10.999.1.1 released"), [])


class TextProblemTests(unittest.TestCase):
    def test_text_problems_gives_line_numbers(self) -> None:
        home = "/" + "home" + "/someone/x"
        self.assertEqual(hygiene.text_problems(f"ok\n{home}\n"), [(2, "personal filesystem path")])

    def test_text_without_problems_gives_none(self) -> None:
        self.assertEqual(hygiene.text_problems("one\ntwo\n"), [])


class PrivateFileTests(unittest.TestCase):
    def test_private_file(self) -> None:
        for name in (".env", "apps/x/.env.local", "a/secrets/b.txt", "k.pem"):
            with self.subTest(name=name):
                self.assertTrue(hygiene.private_file(PurePosixPath(name)))
        for name in (".env.example", "apps/x/README.md"):
            with self.subTest(name=name):
                self.assertFalse(hygiene.private_file(PurePosixPath(name)))


if __name__ == "__main__":
    unittest.main()

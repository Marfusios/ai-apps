"""Tests for the credential, personal path and private address patterns shared with the checker."""

import unittest
from pathlib import PurePosixPath

from factory import hygiene

PRIVATE = ".".join(["10", "0", "0", "5"])  # joined at run time: the repository checker refuses the literal
OTHER_PRIVATE = ".".join(["192", "168", "1", "20"])


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

    def test_an_address_ending_a_sentence_or_a_clause_is_a_problem(self) -> None:
        for text in (f"It is at {PRIVATE}.", f"It is at {PRIVATE}...", f"At {OTHER_PRIVATE}, then elsewhere."):
            with self.subTest(text):
                self.assertEqual(hygiene.line_problems(text), ["private network address"])

    def test_a_longer_dotted_number_is_not_an_address(self) -> None:
        for text in (f"version {PRIVATE}.2", f"version {PRIVATE}.2.", "version 1.2.3.4.5"):
            with self.subTest(text):
                self.assertEqual(hygiene.line_problems(text), [])

    def test_a_control_character_cannot_split_a_finding(self) -> None:
        """compose removes control characters before posting, so a match must not depend on them."""
        key = "sk-" + "a" * 10 + "\x1c" + "a" * 14
        home = "/" + "ho\x01me" + "/someone/x"
        address = "10.0" + "\x7f" + ".0.5"
        cases = {key: "possible provider key", home: "personal filesystem path", address: "private network address"}
        for text, label in cases.items():
            with self.subTest(label):
                self.assertEqual(hygiene.line_problems(f"see {text} here"), [label])
                self.assertEqual(hygiene.text_problems(f"first line\nsee {text} here"), [(2, label)])

    def test_a_tab_still_separates(self) -> None:
        self.assertEqual(hygiene.line_problems("sk-" + "a" * 10 + "\t" + "a" * 14), [])


class TextProblemTests(unittest.TestCase):
    def test_text_problems_gives_line_numbers(self) -> None:
        home = "/" + "home" + "/someone/x"
        self.assertEqual(hygiene.text_problems(f"ok\n{home}\n"), [(2, "personal filesystem path")])

    def test_text_without_problems_gives_none(self) -> None:
        self.assertEqual(hygiene.text_problems("one\ntwo\n"), [])

    def test_lines_end_only_at_a_newline(self) -> None:
        home = "/" + "home" + "/someone/x"
        self.assertEqual(hygiene.text_problems(f"ok\r\n{home}\r\n"), [(2, "personal filesystem path")])
        self.assertEqual(hygiene.text_problems(f"ok\x1d{home}"), [(1, "personal filesystem path")])


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

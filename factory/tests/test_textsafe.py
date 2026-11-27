"""Tests for neutralising agent-written text before it is posted to GitHub."""

import unittest

from factory import textsafe

Z = textsafe.ZWSP
CASES = [
    ("thanks @octocat and @org/team", f"thanks @{Z}octocat and @{Z}org/team"),
    ("Closes #12, see GH-7 and gh-8", f"Closes #{Z}12, see GH-{Z}7 and gh-{Z}8"),
    ("fixes: https://github.com/o/r/issues/5", f"f{Z}ixes: https://github.com/o/r/issues/5"),
    ("RESOLVED https://github.com/o/r/pull/5", f"R{Z}ESOLVED https://github.com/o/r/pull/5"),
    ("a <!-- factory:v1 {} --> b", "a &lt;!-- factory:v1 {} --> b"),
    ("![x](https://example.com/a.png) <IMG src=x>", "[x](https://example.com/a.png) &lt;IMG src=x>"),
    ("line\r\nnext\x00\x07\tend", "line\nnext\tend"),
    ("issue # 5 and email a@", "issue # 5 and email a@"),  # nothing to break
    ("prefixes https://x and fixed it", "prefixes https://x and fixed it"),  # not a whole word
    ("`@octocat` in code", f"`@{Z}octocat` in code"),  # code spans are not exempt
]


class NeutraliseTests(unittest.TestCase):
    def test_rules(self) -> None:
        for raw, expected in CASES:
            with self.subTest(raw=raw):
                self.assertEqual(textsafe.neutralise(raw, 1000), expected)

    def test_short_text_is_not_marked_truncated(self) -> None:
        self.assertEqual(textsafe.neutralise("x" * 100, 100), "x" * 100)

    def test_long_text_is_cut_to_the_limit(self) -> None:
        out = textsafe.neutralise("x" * 500, 100)
        self.assertEqual(len(out), 100)
        self.assertTrue(out.endswith("\n\n(truncated)"))

    def test_the_limit_counts_the_added_characters(self) -> None:
        self.assertLessEqual(len(textsafe.neutralise("@a" * 400, 100)), 100)


class SingleLineTests(unittest.TestCase):
    def test_single_line(self) -> None:
        self.assertEqual(textsafe.single_line("  Fix\n the  @x\tbug ", 80), f"Fix the @{Z}x bug")


if __name__ == "__main__":
    unittest.main()

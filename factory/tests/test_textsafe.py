"""Tests for neutralising agent-written text before it is posted to GitHub."""

import unittest

from factory import textsafe

Z = textsafe.ZWSP
CASES = [
    ("thanks @octocat and @org/team", f"thanks @{Z}octocat and @{Z}org/team"),
    ("Closes #12, see GH-7 and gh-8", f"C{Z}loses #{Z}12, see GH-{Z}7 and gh-{Z}8"),
    ("fixes: https://github.com/o/r/issues/5", f"f{Z}ixes: https://github.com/{Z}o/r/issues/5"),
    ("RESOLVED https://github.com/o/r/pull/5", f"R{Z}ESOLVED https://github.com/{Z}o/r/pull/5"),
    ("a <!-- factory:v1 {} --> b", f"a <{Z}!-- factory:v1 {{}} --> b"),
    ("![x](https://example.com/a.png) <IMG src=x>", f"[{Z}x](https://example.com/a.png) <{Z}IMG src=x>"),
    ("line\r\nnext\x00\x07\tend", "line\nnext\tend"),
    ("one two three", "onetwothree"),  # line and paragraph separators split lines for some readers
    ("issue # 5 and email a@", "issue # 5 and email a@"),  # nothing to break
    ("prefixes https://x and fixed it", f"prefixes https://x and f{Z}ixed it"),  # only the whole word
    ("`@octocat` in code", f"`@{Z}octocat` in code"),  # code spans are not exempt
    ("!![x](u) and !!![x][r]", f"[{Z}x](u) and [{Z}x][r]"),
    ("&#x40;octocat &commat;octocat", "&amp;#x40;octocat &amp;commat;octocat"),
    ("&#x23;12 &num;12 GH&#x2d;7", "&amp;#x23;12 &amp;num;12 GH&amp;#x2d;7"),
    ("F&#x69;xes https://x", "F&amp;#x69;xes https://x"),
    ("a & b &c d", "a & b &c d"),  # not a character reference
    ("<IMAGE src=x> <image>", f"<{Z}IMAGE src=x> <{Z}image>"),
    ("Fixes <https://github.com/o/r/issues/5>", f"F{Z}ixes https://github.com/{Z}o/r/issues/5"),
    ("see <https://example.com/docs> and <http://example.org/a?b=c#d>",
     "see https://example.com/docs and http://example.org/a?b=c#d"),
    ("<HTTPS://example.com/x>", "HTTPS://example.com/x"),
    ("<https://user@example.com>", f"https://user@{Z}example.com"),  # the later rules still apply to the URL
    ("<ftp://example.com> <mailto:a@b.c> <https://> <https://a b>",
     f"<{Z}ftp://example.com> <{Z}mailto:a@{Z}b.c> <{Z}https://> <{Z}https://a b>"),  # not an autolink
    ("**Fixes** https://github.com/o/r/issues/5", f"**F{Z}ixes** https://github.com/{Z}o/r/issues/5"),
    ("Fixes [it](https://github.com/o/r/issues/5)", f"F{Z}ixes [it](https://github.com/{Z}o/r/issues/5)"),
    ("fix the bug", f"f{Z}ix the bug"),
    ("__Fixes__ https://x and _Fixes_ https://x", f"__F{Z}ixes__ https://x and _F{Z}ixes_ https://x"),
    ("Fixes\nhttps://github.com/o/r/issues/5", f"F{Z}ixes\nhttps://github.com/{Z}o/r/issues/5"),
    ('Fixes <a href="https://x">it</a>', f'F{Z}ixes <{Z}a href="https://x">it<{Z}/a>'),
    ("Closed-loop", f"C{Z}losed-loop"),
    ("closet fixture prefixes unfixed fixes2", "closet fixture prefixes unfixed fixes2"),  # not whole words
    ("```mermaid\ngraph TD\n```", f"```m{Z}ermaid\ngraph TD\n```"),
    ("~~~ Mermaid\nx\n~~~", f"~~~ M{Z}ermaid\nx\n~~~"),
    ("```\tmermaid\nx\n```", f"```\tm{Z}ermaid\nx\n```"),
    ("> ```mermaid\n> x", f"> ```m{Z}ermaid\n> x"),
    ("- ```mermaid\n  x", f"- ```m{Z}ermaid\n  x"),
    ('<pre lang="mermaid">', f'<{Z}pre lang="m{Z}ermaid">'),
    ("Mermaid diagrams are nice", f"M{Z}ermaid diagrams are nice"),
    ("See https://github.com/o/r/issues/98", f"See https://github.com/{Z}o/r/issues/98"),
    ("HTTPS://GITHUB.COM/o/r/pull/7", f"HTTPS://GITHUB.COM/{Z}o/r/pull/7"),
    ("www.github.com/o/r", f"www.github.com/{Z}o/r"),
    ("github.com/ alone and notgithub.com", f"github.com/{Z} alone and notgithub.com"),
    ("- [ ] a", f"- [{Z} ] a"),
    ("* [x] b", f"* [{Z}x] b"),
    ("1. [X] c", f"1. [{Z}X] c"),
    ("  2) [ ] d\n+ [x] e", f"  2) [{Z} ] d\n+ [{Z}x] e"),
    ("[ ] not a list", f"[{Z} ] not a list"),
    ("> - [ ] a", f"> - [{Z} ] a"),
    ("1. > - [x] b", f"1. > - [{Z}x] b"),
    ("arr[x] and arr[y]", f"arr[{Z}x] and arr[y]"),
    ("<b>bold", f"<{Z}b>bold"),
    ("</b>", f"<{Z}/b>"),
    ("<details>", f"<{Z}details>"),
    ("<?x", f"<{Z}?x"),
    ('<a href="https://example.com">x', f'<{Z}a href="https://example.com">x'),
    ("a < b, x <3, a<=b, <", "a < b, x <3, a<=b, <"),
    ("See[^1]", f"See[{Z}^1]"),
    ("[^1]: text", f"[{Z}^1]: text"),
    ("- [link](u) and - [y]", "- [link](u) and - [y]"),
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

    def test_a_limit_smaller_than_the_truncation_mark_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            textsafe.neutralise("x" * 100, 5)


class SingleLineTests(unittest.TestCase):
    def test_single_line(self) -> None:
        self.assertEqual(textsafe.single_line("  Fix\n the  @x\tbug ", 80), f"F{Z}ix the @{Z}x bug")

    def test_a_cut_title_stays_on_one_line_within_the_limit(self) -> None:
        out = textsafe.single_line("word " * 50, 40)
        self.assertNotIn("\n", out)
        self.assertLessEqual(len(out), 40)
        self.assertTrue(out.endswith("(truncated)"))


if __name__ == "__main__":
    unittest.main()

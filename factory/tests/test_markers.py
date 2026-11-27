"""Tests for the machine-readable marker the bot puts in its own comments."""

import unittest

from factory import markers


class MarkerTests(unittest.TestCase):
    def test_round_trip(self) -> None:
        data = {"kind": "run", "job": "20261127T101500Z-fix_issue-12-1a2b3c4d", "outcome": "done"}
        self.assertEqual(markers.parse("text\n\n" + markers.encode(data)), data)

    def test_encoded_marker_is_one_line_with_sorted_keys(self) -> None:
        encoded = markers.encode({"b": 1, "a": 2})
        self.assertEqual(encoded, '<!-- factory:v1 {"a":2,"b":1} -->')

    def test_encoded_marker_cannot_close_the_comment_early(self) -> None:
        self.assertNotIn("-->", markers.encode({"a": "x --> y <!-- z"})[:-3])
        self.assertEqual(markers.parse(markers.encode({"a": "x --> y"})), {"a": "x --> y"})

    def test_last_marker_wins_and_bad_ones_are_none(self) -> None:
        two = markers.encode({"n": 1}) + "\n" + markers.encode({"n": 2})
        self.assertEqual(markers.parse(two), {"n": 2})
        for body in ("", "plain", "<!-- factory:v1 not json -->", "<!-- factory:v1 [1] -->", '<!-- factory:v1 {"a":'):
            with self.subTest(body=body):
                self.assertIsNone(markers.parse(body))


if __name__ == "__main__":
    unittest.main()

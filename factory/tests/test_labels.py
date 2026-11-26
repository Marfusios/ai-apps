"""Tests for keeping GitHub labels in line with the factory configuration."""

import io
import subprocess
import unittest
from contextlib import redirect_stderr, redirect_stdout

from factory.config import Label, load
from factory.labels import main, plan

WANTED = Label("factory:epic", "5319e7", "Run it", "person")
OTHER = Label("factory:fix", "d93f0b", "Fix it", "person")


def existing(name="factory:epic", color="5319e7", description="Run it"):
    return {"name": name, "color": color, "description": description}


class FakeGh:
    def __init__(self, listing="[]", listing_code=0, create_code=0):
        self.listing, self.listing_code, self.create_code = listing, listing_code, create_code
        self.calls = []

    def __call__(self, argv):
        self.calls.append(argv)
        if argv[:3] == ["gh", "label", "list"]:
            return subprocess.CompletedProcess(argv, self.listing_code, self.listing, "boom")
        return subprocess.CompletedProcess(argv, self.create_code, "", "failed")


def run_main(fake, *args):
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        code = main(list(args), run=fake)
    return code, out.getvalue(), err.getvalue()


class PlanTest(unittest.TestCase):
    def test_missing_label_is_created(self):
        self.assertEqual(plan([WANTED], []), [("create", WANTED)])

    def test_label_with_other_colour_or_description_is_updated(self):
        self.assertEqual(plan([WANTED], [existing(color="000000")]), [("update", WANTED)])
        self.assertEqual(plan([WANTED], [existing(description="Old")]), [("update", WANTED)])
        self.assertEqual(plan([WANTED], [existing(description=None)]), [("update", WANTED)])

    def test_matching_label_needs_no_action(self):
        self.assertEqual(plan([WANTED], [existing(color="#5319E7")]), [])

    def test_labels_not_in_the_configuration_are_left_alone(self):
        self.assertEqual(plan([WANTED], [existing(), existing(name="bug", color="ffffff")]), [])

    def test_actions_follow_the_order_of_the_configuration(self):
        self.assertEqual(plan([OTHER, WANTED], []), [("create", OTHER), ("create", WANTED)])


class MainTest(unittest.TestCase):
    def test_plan_is_printed_and_only_the_listing_is_called(self):
        fake = FakeGh(listing='[{"name": "factory:epic", "color": "000000", "description": "Run it"}]')
        code, out, _ = run_main(fake)
        self.assertEqual(code, 0)
        self.assertIn("update factory:epic", out)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0][:3], ["gh", "label", "list"])

    def test_up_to_date_message_when_nothing_differs(self):
        labels = load().labels
        listing = "[" + ",".join(
            '{"name": "%s", "color": "%s", "description": "%s"}' % (l.name, l.color, l.description)
            for l in labels
        ) + "]"
        code, out, _ = run_main(FakeGh(listing=listing))
        self.assertEqual((code, out), (0, "Labels are up to date.\n"))

    def test_apply_creates_each_label_with_force(self):
        fake = FakeGh()
        code, out, _ = run_main(fake, "--apply")
        self.assertEqual(code, 0)
        creates = [c for c in fake.calls if c[:3] == ["gh", "label", "create"]]
        self.assertEqual(len(creates), len(load().labels))
        self.assertEqual(
            creates[0],
            ["gh", "label", "create", "factory:epic", "--color", "5319e7",
             "--description", creates[0][7], "--force"],
        )
        self.assertIn("create factory:epic", out)

    def test_apply_exits_non_zero_when_a_call_fails(self):
        code, _, err = run_main(FakeGh(create_code=1), "--apply")
        self.assertEqual(code, 1)
        self.assertIn("factory:epic", err)

    def test_failing_listing_exits_one_with_a_message(self):
        fake = FakeGh(listing_code=1)
        code, out, err = run_main(fake, "--apply")
        self.assertEqual((code, out), (1, ""))
        self.assertTrue(err.startswith("Cannot list labels"))
        self.assertEqual(len(fake.calls), 1)


if __name__ == "__main__":
    unittest.main()

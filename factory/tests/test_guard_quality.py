"""Tests for the quality guard hook: no silenced checks or skipped tests without a reason."""

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from factory.tests.hookload import load_hook

guard_quality = load_hook("guard_quality")
find_violations = guard_quality.find_violations
PATH = "apps/x/a.ts"


class FindViolationsTests(unittest.TestCase):
    def flagged(self, *lines: str, path: str = PATH) -> None:
        for line in lines:
            with self.subTest(line=line):
                self.assertEqual(find_violations(path, "", line), [line.strip()])

    def passes(self, *lines: str, path: str = PATH) -> None:
        for line in lines:
            with self.subTest(line=line):
                self.assertEqual(find_violations(path, "", line), [])

    def test_focused_test_is_always_a_violation(self):
        self.flagged("it.only('x', () => {})", "describe.only('x', () => {})", "test.only('x', f)",
                     "suite.only('x', f)", "context.only('x', f)", "fit('x', () => {})",
                     "fdescribe('x', () => {})", "it.only('x', f) // while debugging the import step")

    def test_focus_chains_and_fdescribe_with_any_argument_are_violations(self):
        self.flagged("fdescribe(name, () => {})", "it.concurrent.only('x', f)", "it.only.each([1, 2])('x', f)",
                     "test.only.each(table)('x', f)", "describe.only.each([[1]])('x', f)",
                     "test.concurrent.only.each(table)('x', f)")

    def test_ordinary_code_resembling_the_markers_is_not_flagged(self):
        self.passes("const total = profit(a) + benefit(b) + outfit(c)", "submit.only(x)", "model.fit(data)",
                    "fit(data, labels)", "const bit = it.onlyOnce(x)", "// the fit() helper", "x = unfit(y)",
                    "exit(1)", "process.exit(0)", "sys.exit(2)", "const next = exit(code)")

    def test_bare_suppressions_are_violations(self):
        self.flagged("// eslint-disable-next-line no-console", "// @ts-ignore", "x = f()  # noqa: E501",
                     "y = g()  # type: ignore[arg-type]", "// @ts-nocheck", "/* eslint-disable */",
                     "// biome-ignore lint/suspicious/noExplicitAny", "z = h()  # pylint: disable=invalid-name",
                     "z = h()  # pyright: ignore[reportGeneralTypeIssues]", "f() //nolint:errcheck",
                     "#[allow(dead_code)]", '@SuppressWarnings("unchecked")', "/* istanbul ignore next */",
                     "/* c8 ignore next */", "/* v8 ignore next */", "if x:  # pragma: no cover", "x = f()  # noqa")

    def test_reasoned_suppressions_pass(self):
        self.passes("// eslint-disable-next-line no-console -- the CLI prints its result here",
                    "// @ts-expect-error upstream types omit this overload",
                    "x = f()  # noqa: E501 long URL kept on one line",
                    "it.skip('x', () => {}) // waits for the index step",
                    "// @ts-ignore: legacy bundle ships no types",
                    "/* eslint-disable no-alert -- the demo asks before it resets */",
                    "// biome-ignore lint/suspicious/noExplicitAny: the payload is untyped by design",
                    "y = g()  # type: ignore[arg-type] the stub misses this overload",
                    "z = h()  # pylint: disable=invalid-name matches the wire format",
                    "f() //nolint:errcheck // best effort cleanup on exit",
                    "#[allow(dead_code)] // used only by the generated bindings",
                    '@SuppressWarnings("unchecked") // the cast is checked above',
                    "/* istanbul ignore next -- only reached on Windows paths */",
                    "if x:  # pragma: no cover only reached on Windows")

    def test_marker_spellings_in_other_case_or_spacing_are_violations(self):
        self.flagged("x = f()  # NOQA", "x = f()  #noqa", "x = f()  #  Noqa: E501", "y = g()  # type:ignore",
                     "y = g()  #type:ignore[arg-type]", "y = g()  # TYPE: IGNORE", "z = h()  # pylint:disable=foo",
                     "z = h()  #pylint: disable=foo", "z = h()  # PYLINT: DISABLE=foo", "z = h()  # pyright:ignore",
                     "z = h()  #pyright: ignore[x]", "z = h()  # Pyright: Ignore", "f() // nolint", "f() // NOLINT",
                     "f() //  NoLint:errcheck", "// ESLINT-DISABLE-NEXT-LINE no-console",
                     "// Eslint-Disable-Next-Line no-console", "/* ESLINT-DISABLE */", "// @TS-IGNORE",
                     "/* ISTANBUL IGNORE NEXT */", "if x:  # Pragma: No Cover")

    def test_marker_spellings_in_other_case_or_spacing_pass_with_a_reason(self):
        self.passes("x = f()  # NOQA: E501 long URL kept on one line", "x = f()  #noqa: E501 long URL kept here",
                    "y = g()  #type:ignore[arg-type] the stub misses this overload",
                    "y = g()  # TYPE: IGNORE[arg-type] the stub misses this overload",
                    "z = h()  # pylint:disable=foo matches the wire format",
                    "z = h()  # PYLINT: DISABLE=foo matches the wire format",
                    "z = h()  #pyright:ignore[x] the stub misses this overload",
                    "z = h()  # Pyright: Ignore[x] the stub misses this overload",
                    "f() // NOLINT:errcheck best effort cleanup on exit", "f() //nolint:errcheck best effort cleanup",
                    "// ESLINT-DISABLE-NEXT-LINE no-console -- the CLI prints its result here")

    def test_a_reason_needs_two_words_of_three_letters(self):
        self.flagged("// @ts-ignore ok", "// @ts-ignore it is", "x = f()  # noqa: E501 a b",
                     "// eslint-disable-next-line no-console -- ok")

    def test_eslint_rule_names_do_not_count_as_a_reason(self):
        self.flagged("// eslint-disable-next-line no-console, no-alert",
                     "// eslint-disable-next-line no-console no-alert",
                     "// eslint-disable-next-line no-console - the CLI prints its result here")

    def test_skipped_tests_need_a_reason(self):
        self.flagged("it.skip('x', () => {})", "describe.skip('x', () => {})", "test.skip('x', f)",
                     "xit('x', () => {})", "xdescribe('x', f)", "xtest('x', f)", "t.Skip()", "#[ignore]",
                     "@Disabled", "@Ignore", "@pytest.mark.skip", "@unittest.skip",
                     '@pytest.mark.skip(reason="flaky")', '@Disabled("flaky")')

    def test_skipped_tests_with_a_reason_pass(self):
        self.passes("xit('x', () => {}) // waits for the index step",
                    "t.Skip() // needs the network service",
                    "#[ignore] // takes minutes on the shared runner",
                    '@pytest.mark.skip(reason="waits for the index step")',
                    '@unittest.skip("waits for the index step")',
                    '@Disabled("waits for the index step")', '@Ignore("waits for the index step")',
                    "@Disabled // waits for the index step")

    def test_conditional_skips_are_not_unconditional_skips(self):
        self.passes('@pytest.mark.skipif(sys.platform == "win32", reason="posix only")',
                    '@unittest.skipIf(sys.platform == "win32", "posix only")')

    def test_existing_lines_are_not_reported_again(self):
        line = "// @ts-ignore"
        self.assertEqual(find_violations(PATH, f"a()\n  {line}  \nb()", f"a()\n{line}\nc()"), [])

    def test_a_new_copy_of_an_old_line_text_is_compared_by_line_not_substring(self):
        self.assertEqual(find_violations(PATH, "x // @ts-ignore here", "// @ts-ignore"), ["// @ts-ignore"])

    def test_only_new_lines_are_reported(self):
        self.assertEqual(find_violations(PATH, "// @ts-ignore", "// @ts-ignore\nit.only('x', f)\nok()"),
                         ["it.only('x', f)"])

    def test_documents_and_harness_files_are_ignored(self):
        for path in ("README.md", "docs/a.ts", ".claude/hooks/a.py", "factory/a.py", "apps/x/notes.txt",
                     "apps/x/data.json"):
            with self.subTest(path=path):
                self.assertEqual(find_violations(path, "", "// @ts-ignore\nit.only('x', f)"), [])

    def test_source_extensions_are_checked(self):
        for suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs",
                       ".java", ".kt", ".cs", ".rb", ".php", ".PY"):
            with self.subTest(suffix=suffix):
                self.assertTrue(find_violations(f"apps/x/a{suffix}", "", "// @ts-ignore"))

    def test_paths_with_backslashes_are_understood(self):
        self.assertEqual(find_violations("docs\\a.ts", "", "// @ts-ignore"), [])
        self.assertTrue(find_violations("apps\\x\\a.ts", "", "// @ts-ignore"))


class MainTests(unittest.TestCase):
    def setUp(self) -> None:
        holder = tempfile.TemporaryDirectory()
        self.addCleanup(holder.cleanup)
        self.project = Path(holder.name).resolve()
        (self.project / "apps" / "x").mkdir(parents=True)
        patcher = mock.patch.dict(os.environ, {"CLAUDE_PROJECT_DIR": str(self.project)})
        patcher.start()
        self.addCleanup(patcher.stop)

    def run_hook(self, tool: str, tool_input: object, cwd: object = None) -> str:
        data = {"tool_name": tool, "tool_input": tool_input, "cwd": str(self.project) if cwd is None else cwd}
        stdin = io.TextIOWrapper(io.BytesIO(json.dumps(data).encode()))
        output = io.StringIO()
        with mock.patch("sys.stdin", stdin), contextlib.redirect_stdout(output), \
                self.assertRaises(SystemExit) as raised:
            guard_quality.main()
        self.assertEqual(raised.exception.code, 0)
        return output.getvalue()

    def denial(self, output: str) -> str:
        decision = json.loads(output)["hookSpecificOutput"]
        self.assertEqual(decision["permissionDecision"], "deny")
        return decision["permissionDecisionReason"]

    def test_write_with_a_bare_suppression_is_denied_with_the_line_and_the_fix(self):
        reason = self.denial(self.run_hook("Write", {"file_path": "apps/x/a.ts", "content": "// @ts-ignore\nfoo()"}))
        self.assertIn("// @ts-ignore", reason)
        self.assertIn("reason", reason)

    def test_the_reason_for_a_focused_test_says_to_remove_only(self):
        reason = self.denial(self.run_hook("Write", {"file_path": "apps/x/a.ts", "content": "it.only('x', f)"}))
        self.assertIn(".only", reason)

    def test_the_reason_lists_at_most_ten_lines_of_at_most_160_characters(self):
        content = chr(10).join(f"x{i}(); // @ts-ignore" for i in range(15))
        reason = self.denial(self.run_hook("Write", {"file_path": "apps/x/a.ts", "content": content}))
        self.assertIn("x9()", reason)
        self.assertNotIn("x10()", reason)
        text = "foo(" + "a" * 400 + "); // @ts-ignore"
        reason = self.denial(self.run_hook("Write", {"file_path": "apps/x/a.ts", "content": text}))
        listed = [line for line in reason.splitlines() if "foo(" in line]
        self.assertEqual(len(listed), 1)
        self.assertLessEqual(len(listed[0].strip()), 160)

    def test_write_compares_with_the_current_content_of_the_file(self):
        (self.project / "apps" / "x" / "a.ts").write_text("// @ts-ignore\nold()\n", encoding="utf-8")
        output = self.run_hook("Write", {"file_path": "apps/x/a.ts", "content": "// @ts-ignore\nnew()\n"})
        self.assertEqual(output, "")

    def test_edit_compares_old_and_new_strings(self):
        tool_input = {"file_path": "apps/x/a.ts", "old_string": "// @ts-ignore\na()", "new_string": "// @ts-ignore\nb()"}
        self.assertEqual(self.run_hook("Edit", tool_input), "")
        tool_input["old_string"] = "a()"
        self.assertIn("@ts-ignore", self.denial(self.run_hook("Edit", tool_input)))

    def test_multiedit_checks_every_edit(self):
        edits = [{"old_string": "a", "new_string": "b"}, {"old_string": "c", "new_string": "it.skip('x', f)"}]
        reason = self.denial(self.run_hook("MultiEdit", {"file_path": "apps/x/a.ts", "edits": edits}))
        self.assertIn("it.skip", reason)

    def test_notebook_edit_is_checked_as_python(self):
        tool_input = {"notebook_path": "apps/x/n.ipynb", "new_source": "x = f()  # noqa"}
        self.assertIn("noqa", self.denial(self.run_hook("NotebookEdit", tool_input)))

    def test_harmless_input_prints_nothing(self):
        self.assertEqual(self.run_hook("Write", {"file_path": "apps/x/a.ts", "content": "foo()"}), "")

    def test_files_outside_the_project_unknown_tools_and_odd_input_are_allowed(self):
        bad = "// @ts-ignore"
        outside = str(self.project.parent / "elsewhere" / "a.ts")
        self.assertEqual(self.run_hook("Write", {"file_path": outside, "content": bad}), "")
        self.assertEqual(self.run_hook("Bash", {"command": bad}), "")
        self.assertEqual(self.run_hook("Write", {"file_path": "apps/x/a.ts"}), "")
        self.assertEqual(self.run_hook("Write", {"file_path": 7, "content": bad}), "")
        self.assertEqual(self.run_hook("MultiEdit", {"file_path": "apps/x/a.ts", "edits": "no"}), "")
        self.assertEqual(self.run_hook("Edit", "text"), "")

    def test_a_failure_inside_the_hook_allows_the_call_silently(self):
        with mock.patch.object(guard_quality, "find_violations", side_effect=RuntimeError("boom")):
            self.assertEqual(self.run_hook("Write", {"file_path": "apps/x/a.ts", "content": "// @ts-ignore"}), "")


if __name__ == "__main__":
    unittest.main()

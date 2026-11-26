"""Tests for the shell text parser the hooks share, called directly and not through the git rules."""

import base64
import unittest

from factory.tests.hookload import load_hook

shell_words = load_hook("shell_words")


def commands(text: str) -> list[tuple[str, list[str]]]:
    return [(command.name, command.args) for command in shell_words.parse(text).commands]


class SplitTest(unittest.TestCase):
    def test_every_separator_starts_a_new_simple_command(self):
        for separator in (";", "&&", "||", "|", "&", "\n"):
            with self.subTest(separator):
                self.assertEqual(commands(f"first a {separator} second b"), [("first", ["a"]), ("second", ["b"])])

    def test_redirections_stay_with_their_command_but_are_not_its_arguments(self):
        self.assertEqual(commands("run a 2>&1 > out.log"), [("run", ["a"])])

    def test_quoted_separators_do_not_split(self):
        self.assertEqual(commands("run 'a; b' \"c && d\""), [("run", ["a; b", "c && d"])])

    def test_line_continuations_are_removed(self):
        self.assertEqual(shell_words.unfold("run \\\n  a"), "run   a")

    def test_unbalanced_quotes_raise(self):
        with self.assertRaises(ValueError):
            shell_words.parse("run 'a")


class WrapperTest(unittest.TestCase):
    def test_assignments_and_wrappers_are_stripped_before_the_command_name(self):
        script = shell_words.parse("A=1 sudo -u root env B=2 nice -n 5 timeout 30 run x")
        (command,) = script.commands
        self.assertEqual((command.name, command.args), ("run", ["x"]))
        self.assertEqual(command.assignments, ["A=1", "B=2"])

    def test_the_program_is_matched_by_base_name_without_case_or_exe(self):
        for word in ("RUN.EXE", "/usr/bin/run", "c:/tools/Run.exe"):
            with self.subTest(word):
                self.assertEqual(commands(f"{word} x"), [("run", ["x"])])


class NestedTextTest(unittest.TestCase):
    def nested(self, text: str) -> list[str]:
        (command,) = shell_words.parse(text).commands
        return command.nested

    def test_shells_and_eval_expose_their_inner_text(self):
        self.assertEqual(self.nested("sh -c 'inner one'"), ["inner one"])
        self.assertEqual(self.nested("bash -lc 'inner two'"), ["inner two"])
        self.assertEqual(self.nested("eval inner three"), ["inner three"])
        self.assertEqual(self.nested("cmd /c inner four"), ["inner four"])
        self.assertEqual(self.nested("pwsh -Command inner five"), ["inner five"])

    def test_an_encoded_powershell_command_is_decoded(self):
        encoded = base64.b64encode("inner six".encode("utf-16-le")).decode("ascii")
        self.assertEqual(self.nested(f"pwsh -EncodedCommand {encoded}"), ["inner six"])

    def test_a_shell_without_command_text_has_none(self):
        self.assertEqual(self.nested("bash script.sh"), [])

    def test_substitutions_and_piped_text_are_exposed(self):
        script = shell_words.parse("echo $(inner seven) `inner eight` 'not $(run)'")
        self.assertEqual(script.substitutions, ["inner seven", "inner eight"])
        self.assertEqual(shell_words.parse("echo 'inner nine' | sh").stdin_texts, ["inner nine", "inner nine"])
        self.assertEqual(shell_words.parse("echo 'inner nine' | tee out").stdin_texts, [])


class HeredocTest(unittest.TestCase):
    def test_the_body_is_dropped_for_cat_and_kept_for_a_shell(self):
        self.assertEqual(commands("cat > f <<EOF\nrun inside\nEOF"), [("cat", [])])
        self.assertIn(("run", ["inside"]), commands("bash <<EOF\nrun inside\nEOF"))

    def test_commands_substituted_into_an_unquoted_body_are_still_found(self):
        self.assertIn(("inner", ["ten"]), commands("cat <<EOF\n$(inner ten)\nEOF"))
        self.assertNotIn(("inner", ["ten"]), commands("cat <<'EOF'\n$(inner ten)\nEOF"))


class VariantTest(unittest.TestCase):
    def test_a_powershell_continuation_gives_a_second_reading(self):
        self.assertEqual(shell_words.variants("run `\n a"), ["run `\n a", "run  a"])
        self.assertEqual(shell_words.variants("run `code`\n a"), ["run `code`\n a"])


class OptionTest(unittest.TestCase):
    def test_options_are_split_into_letters_long_names_and_operands(self):
        self.assertEqual(shell_words.parse_options(["-ab", "--long=1", "x", "--", "-y"]), ("ab", ["long"], ["x", "-y"]))

    def test_an_option_value_is_not_an_operand(self):
        self.assertEqual(shell_words.parse_options(["-o", "v", "x"], values="o"), ("o", [], ["x"]))
        self.assertEqual(shell_words.parse_options(["--with", "v", "x"], value_longs=("with",)), ("", ["with"], ["x"]))


if __name__ == "__main__":
    unittest.main()

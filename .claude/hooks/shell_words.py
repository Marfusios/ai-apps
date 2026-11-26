"""Turn shell command text into simple commands, their wrappers and nested shell texts, knowing nothing of git or gh."""

import base64
import os
import re
import shlex
from collections.abc import Sequence
from dataclasses import dataclass

PUNCTUATION = "();<>|&\n"
REDIRECTIONS = {"<", ">", ">>", "<>", ">|", "<&", ">&", "&>", "&>>", "<<", "<<<"}
HEREDOC = re.compile(r"(?<!<)<<(?!<)-?[ \t]*(\\?)(['\"]?)([\w.-]+)\2")
POWERSHELL_CONTINUATION = re.compile(r"(?<=[ \t])`\n")
ASSIGNMENT = re.compile(r"(?:\$env:)?([A-Za-z_]\w*)=(.*)", re.IGNORECASE | re.DOTALL)
RESERVED = {"!", "{", "}", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac"}
# Wrappers that run the rest of their words as a command, with their short options that take a value.
WRAPPERS = {"command": "", "builtin": "", "nohup": "", "exec": "a", "env": "uCS", "sudo": "CDghpRrTtUu",
            "nice": "n", "ionice": "cnPpu", "time": "fo", "timeout": "ks", "xargs": "adEeIiLlnPs"}
POSIX_SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
POWERSHELLS = {"pwsh", "powershell"}
SHELLS = POSIX_SHELLS | POWERSHELLS | {"cmd"}
EVALS = {"eval", "iex", "invoke-expression"}
PRINTERS = {"echo", "printf", "write-output"}


@dataclass(frozen=True)
class Command:
    """One simple command: its program name, arguments, NAME=value prefix and the shell texts it runs itself."""

    name: str
    args: list[str]
    assignments: list[str]
    nested: list[str]


@dataclass(frozen=True)
class Script:
    """What a shell text runs: commands substituted into it, its simple commands, and text fed to a shell's stdin."""

    substitutions: list[str]
    commands: list[Command]
    stdin_texts: list[str]


def variants(command: str) -> list[str]:
    """The readings of a command text to inspect: as written, and with PowerShell's backtick continuations joined.

    A backtick after a space continues a line in PowerShell; a backtick ending a word closes markdown code instead."""
    command = command.replace("\r\n", "\n")
    continued = POWERSHELL_CONTINUATION.sub("", command)
    return [command, continued] if continued != command else [command]


def unfold(text: str) -> str:
    """The text with line continuations (a backslash before a newline) removed."""
    return text.replace("\\\n", "")


def parse(text: str) -> Script:
    """Read shell text into its commands; raises ValueError when quotes do not balance."""
    body = drop_text_heredocs(text)
    parts = segments(tokenize(body))
    commands = []
    for part in parts:
        name, args, assignments = command_of(part)
        commands.append(Command(name, args, assignments, nested_texts(name, args)))
    stdin_texts = stdin_feed(parts) if any(reads_stdin(c.name, c.args) for c in commands) else []
    return Script(substitutions(body), commands, stdin_texts)


def enter(cwd: str, target: str) -> str:
    """The directory that cd or git -C reaches from cwd, reading Git Bash's /c/... as c:/... on Windows."""
    if os.name == "nt":
        target = re.sub(r"^/([A-Za-z])(?:/|$)", r"\1:/", target)
    return os.path.join(cwd, os.path.expanduser(target))


def parse_options(args: list[str], values: str = "", optional: str = "",
                  value_longs: Sequence[str] = ()) -> tuple[str, list[str], list[str]]:
    """Split arguments into short flag letters, long option names and operands."""
    letters, longs, operands, index = "", [], [], 0
    while index < len(args):
        arg = args[index]
        index += 1
        if arg == "--":
            operands += args[index:]
            break
        if arg.startswith("--"):
            name, equals, _ = arg[2:].partition("=")
            longs.append(name)
            if name in value_longs and not equals:
                index += 1
        elif arg.startswith("-") and arg != "-":
            flags, value_follows = short_flags(arg[1:], values, optional)
            letters += flags
            index += value_follows
        else:
            operands.append(arg)
    return letters, longs, operands


def tokenize(text: str) -> list[str]:
    """Shell words and operator tokens; raises ValueError when quotes do not balance."""
    lexer = shlex.shlex(text, posix=True, punctuation_chars=PUNCTUATION)
    lexer.whitespace = lexer.whitespace.replace("\n", "")
    lexer.whitespace_split = True  # otherwise characters such as : and + split words like feature:main
    lexer.commenters = ""  # shlex drops the newline ending a comment, which would merge the next command into it
    return list(lexer)


def is_operator(token: str) -> bool:
    return token != "" and all(char in PUNCTUATION for char in token)


def segments(tokens: list[str]) -> list[list[str]]:
    """Split tokens into simple commands at separators and brackets; redirections stay with their command."""
    parts: list[list[str]] = [[]]
    for token in tokens:
        if is_operator(token) and token not in REDIRECTIONS:
            parts.append([])
        else:
            parts[-1].append(token)
    return [part for part in parts if part]


def command_words(part: list[str]) -> list[str]:
    """A simple command's words without redirections, their targets and file descriptor numbers."""
    result, target = [], False
    for token in part:
        if token in REDIRECTIONS:
            if result and result[-1].isdigit():
                result.pop()
            target = True
        elif target:
            target = False
        else:
            result.append(token)
    return result


def substitutions(text: str, quoting: bool = True) -> list[str]:
    """Commands in $(...) and backticks that a shell runs: unescaped and, where quotes count, not single-quoted."""
    found, quote, index = [], "", 0
    while index < len(text):
        char = text[index]
        if quote == "'":
            quote = "" if char == "'" else quote
        elif char == "\\":
            index += 1
        elif quoting and char == "'" and not quote:
            quote = "'"
        elif quoting and char == '"':
            quote = "" if quote else '"'
        elif char == "`":
            end = text.find("`", index + 1)
            end = len(text) if end < 0 else end
            found.append(text[index + 1:end])
            index = end
        elif text.startswith("$(", index):
            end = closing_paren(text, index + 2)
            found.append(text[index + 2:end])
            index = end
        index += 1
    return found


def closing_paren(text: str, start: int) -> int:
    """The index of the ) that closes a $( opened just before start, or len(text) when none does.

    A heredoc opened on the first line is skipped, since its body, often a commit message, may hold unbalanced
    parentheses."""
    skip_from = skip_to = len(text)
    line_end = text.find("\n", start)
    heredoc = HEREDOC.search(text, start, line_end) if line_end >= 0 else None
    if heredoc:
        closing = re.compile(rf"\n\t*{re.escape(heredoc[3])}(?=\n|$)").search(text, line_end)
        if closing:
            skip_from, skip_to = line_end, closing.end()
    depth, index = 1, start
    while index < len(text):
        if index == skip_from:
            index = skip_to
            continue
        depth += {"(": 1, ")": -1}.get(text[index], 0)
        if depth == 0:
            return index
        index += 1
    return len(text)


def drop_text_heredocs(text: str) -> str:
    """Remove heredoc bodies that cat or tee only write out, keeping any commands a shell substitutes into them."""
    lines, kept, index = text.split("\n"), [], 0
    while index < len(lines):
        line = lines[index]
        kept.append(line)
        index += 1
        heredocs = HEREDOC.findall(line)
        if not heredocs or not writes_text_only(line, len(heredocs)):
            continue
        for backslash, quote, delimiter in heredocs:
            end = next((i for i in range(index, len(lines)) if lines[i].lstrip("\t") == delimiter), len(lines))
            if not (backslash or quote):
                kept += substitutions("\n".join(lines[index:end]), quoting=False)
            index = end + 1
    return "\n".join(kept)


def writes_text_only(line: str, heredoc_count: int) -> bool:
    """True when every heredoc on the line feeds cat or tee and nothing on the line is a shell."""
    try:
        parts = segments(tokenize(line))
    except ValueError:
        return False
    names = {command_of(part)[0] for part in parts}
    feeding = [command_of(part)[0] for part in parts if "<<" in part]
    counted = sum(part.count("<<") for part in parts) == heredoc_count
    return counted and all(name in ("cat", "tee") for name in feeding) and not names & (SHELLS | EVALS)


def executable(word: str) -> str:
    """A command word's program name: its base name in lower case, without .exe."""
    return re.split(r"[\\/]", word)[-1].lower().removesuffix(".exe")


def command_of(part: list[str]) -> tuple[str, list[str], list[str]]:
    """The program name, arguments and NAME=value prefix of a simple command."""
    words = command_words(part)
    assignments, index = [], 0
    while index < len(words):
        name = executable(words[index])
        if ASSIGNMENT.fullmatch(words[index]):
            assignments.append(words[index])
            index += 1
        elif words[index] in RESERVED:
            index += 1
        elif name in WRAPPERS:
            index = skip_options(words, index + 1, WRAPPERS[name])
            if name == "timeout" and index < len(words):
                index += 1  # the duration, which comes before the command
        else:
            return name, words[index + 1:], assignments
    return "", [], assignments


def skip_options(words: list[str], index: int, values: str) -> int:
    """The index of the first word after a wrapper's options, given its short options that take a value."""
    while index < len(words) and words[index].startswith("-") and words[index] != "-":
        option = words[index]
        index += 1
        if option == "--":
            break
        if not option.startswith("--") and short_flags(option[1:], values)[1]:
            index += 1
    return index


def short_flags(cluster: str, values: str, optional: str = "") -> tuple[str, bool]:
    """The letters of a short-option cluster up to the first one taking a value, and whether the next word is it."""
    for index, letter in enumerate(cluster):
        if letter in values or letter in optional:
            return cluster[:index + 1], letter in values and index == len(cluster) - 1
    return cluster, False


def nested_texts(name: str, args: list[str]) -> list[str]:
    """Command texts that a shell or eval runs from its own arguments."""
    if name in EVALS:
        return [" ".join(args)]
    for index, arg in enumerate(args):
        rest, lowered = args[index + 1:], arg.lower()
        if name in POSIX_SHELLS and re.fullmatch(r"-[A-Za-z]*c[A-Za-z]*", arg):
            return rest  # the first operand is the script; reading the others too only costs time
        if name in POWERSHELLS and len(arg) > 1 and "-command".startswith(lowered):
            return [" ".join(rest)]
        if name in POWERSHELLS and len(arg) > 1 and ("-encodedcommand".startswith(lowered) or lowered == "-ec") and rest:
            return [decode_powershell(rest[0])]
        if name == "cmd" and lowered[:2] in ("/c", "/k"):
            return [" ".join([arg[2:], *rest]).strip()]
    return []


def decode_powershell(value: str) -> str:
    """The text of a PowerShell -EncodedCommand argument, which is base64 of UTF-16LE."""
    try:
        return base64.b64decode(value, validate=True).decode("utf-16-le")
    except ValueError:
        return value


def reads_stdin(name: str, args: list[str]) -> bool:
    """True for a shell given neither command text nor a script, which runs whatever is piped into it."""
    if name not in SHELLS or nested_texts(name, args):
        return False
    switches = ("-", "+") if name in POSIX_SHELLS else ("-", "/")
    if not [arg for arg in args if not arg.startswith(switches)]:
        return True
    return name in POSIX_SHELLS and any(re.fullmatch(r"-[A-Za-z]*s[A-Za-z]*", arg) for arg in args)


def stdin_feed(parts: list[list[str]]) -> list[str]:
    """Text that may reach a shell reading stdin: herestrings, and what echo or printf print."""
    feed = [part[i + 1] for part in parts for i, token in enumerate(part[:-1]) if token == "<<<"]
    for part in parts:
        name, args, _ = command_of(part)
        if name in PRINTERS:
            feed += [*args, " ".join(args)]
    return feed

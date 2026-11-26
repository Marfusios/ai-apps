"""PreToolUse hook: refuse shell commands that break the repository's git rules."""

import base64
import fnmatch
import os
import re
import shlex
import subprocess
import sys
from collections.abc import Callable, Iterable, Iterator, Sequence
from pathlib import Path
from typing import NoReturn

import hooklib
from hooklib import Decision

REPO_ROOT = Path(__file__).resolve().parents[2]
FALLBACK_PROTECTED = ("main", "master")
MAX_DEPTH = 5
REASONS = {
    "G1": "Force pushing is refused: it rewrites history others may have. Push new commits on top instead.",
    "G2": "Deleting remote branches or tags is refused. Leave them in place and tell the person which are no longer needed.",
    "G3": "Pushing to a protected branch such as main is refused. Push your own branch and open a pull request.",
    "G4": "Skipping git hooks is refused. Let the hooks run and fix what they report.",
    "G5": "Rewriting history with filter-branch or filter-repo is refused. Fix the problem in a new commit, or ask the person.",
    "G6": "Deleting a branch or tag through the GitHub API is refused. Leave it in place and tell the person.",
    "G7": "Merging or approving a pull request is the person's decision. Leave the pull request open for their review.",
    "G8": "Changing repository settings, rules, secrets or workflows is the person's decision. Ask them to make the change.",
    "nesting": "The command nests shells more than five levels deep, too deep to inspect. Run the inner command directly.",
    "uninspectable": "The git guard could not inspect this command. Run it in a simpler form.",
}
ASK_WHEN_INTERACTIVE = {"G7", "G8"}

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

GIT_VALUE_OPTIONS = {"-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"}
PUSH_VALUE_OPTIONS = ("push-option", "repo", "receive-pack", "exec")
GH_SETTINGS = ({("repo", c) for c in ("edit", "delete", "rename", "archive", "unarchive")}
               | {(g, c) for g in ("secret", "variable") for c in ("set", "delete", "remove")}
               | {("workflow", "enable"), ("workflow", "disable")})
API_VALUE_OPTIONS = {"-X", "--method", "-H", "--header", "-f", "--raw-field", "-F", "--field", "--input",
                     "-q", "--jq", "-t", "--template", "--cache", "-p", "--preview", "--hostname"}
API_FIELD_OPTIONS = {"-f", "--raw-field", "-F", "--field", "--input"}
SETTINGS_PATHS = ("/rulesets", "/protection", "/actions/permissions", "/actions/secrets", "/actions/variables",
                  "/hooks", "/keys", "/collaborators", "/environments", "/pages", "/vulnerability-alerts",
                  "/private-vulnerability-reporting")

GIT_PUSH = re.compile(r"\bgit\b.*\bpush\b", re.IGNORECASE | re.DOTALL)
TEXT_RULES = [(rule, re.compile(pattern, re.IGNORECASE | re.DOTALL)) for rule, pattern in (
    ("G1", GIT_PUSH.pattern + r".*(?:--force|--mirror|\s-\w*f|\s\+)"),
    ("G2", GIT_PUSH.pattern + r".*(?:--delete|--prune|\s-\w*d|\s:)"),
    ("G3", GIT_PUSH.pattern + r".*--(?:all|branches)\b"),
    ("G4", r"--no-verify|core\.hookspath|\bhusky=0|\bgit\b.*\bcommit\b.*\s-\w*n"),
    ("G5", r"\bgit\b.*\bfilter-(?:branch|repo)\b"),
    ("G6", r"\bgh\b.*\bapi\b(?=.*\bdelete\b).*/git/refs/"),
    ("G7", r"\bgh\b.*(?:\bpr\s+merge\b|\bpr\s+review\b.*(?:--approve|\s-a\b)|\bapi\b.*/merges?\b)"),
    ("G8", r"\bgh\b.*(?:\brepo\s+(?:edit|delete|rename|archive|unarchive)\b|\b(?:secret|variable)\s+(?:set|delete|remove)\b"
           r"|\bworkflow\s+(?:enable|disable)\b|\bapi\b.*(?:" + "|".join(map(re.escape, SETTINGS_PATHS))
           + r"|\brepos/[^/\s]+/[^/\s]+(?:\s|$)))"),
)]


def reason(rule: str) -> str:
    return f"{REASONS[rule]} (AGENTS.md, Git rules)"


def verdict(rules: Iterable[str], factory_run: bool) -> Decision:
    """Deny on the first rule that denies, else ask on the first that asks, else allow."""
    asked = None
    for rule in rules:
        if rule in ASK_WHEN_INTERACTIVE and not factory_run:
            asked = asked or Decision("ask", reason(rule))
        else:
            return Decision("deny", reason(rule))
    return asked or Decision("allow")


def decide(command: str, *, cwd: str, factory_run: bool, protected: Sequence[str],
           current_branch: Callable[[str], str | None]) -> Decision:
    """Allow, ask about or deny a shell command under the git rules G1 to G8."""
    command = command.replace("\r\n", "\n")
    inspection = Inspection(protected, current_branch)
    # PowerShell continues a line with a backtick after a space; a backtick ending a word closes markdown code instead.
    continued = POWERSHELL_CONTINUATION.sub("", command)
    texts = [command, continued] if continued != command else [command]
    return verdict((rule for text in texts for rule in inspection.hits(text, cwd)), factory_run)


def scan_text(command: str, *, cwd: str, factory_run: bool, protected: Sequence[str],
              current_branch: Callable[[str], str | None]) -> Decision:
    """The conservative text scan on its own, for when the full inspection fails."""
    return verdict(Inspection(protected, current_branch).scan(command, cwd), factory_run)


class Inspection:
    """Finds the rules a command breaks, walking its simple commands and the shells nested in them."""

    def __init__(self, protected: Sequence[str], current_branch: Callable[[str], str | None]):
        self.protected = tuple(protected)
        self.current_branch = current_branch
        self.branches: dict[str, str | None] = {}

    def branch(self, directory: str) -> str | None:
        if directory not in self.branches:
            self.branches[directory] = self.current_branch(directory)
        return self.branches[directory]

    def hits(self, text: str, cwd: str, depth: int = 0) -> Iterator[str]:
        """The rules that shell text run in directory cwd breaks, in order; depth counts the enclosing shells."""
        if depth > MAX_DEPTH:
            yield "nesting"
            return
        text = text.replace("\\\n", "")
        try:
            body = drop_text_heredocs(text)
            parts = segments(tokenize(body))
        except ValueError:
            yield from self.scan(text, cwd)
            return
        for inner in substitutions(body):
            yield from self.hits(inner, cwd, depth + 1)
        stdin_shell = False
        for part in parts:
            name, args, assignments = command_of(part)
            if any(disables_husky(word) for word in assignments + (args if name == "export" else [])):
                yield "G4"
            rule = None
            if name in ("cd", "pushd") and args and args[-1] != "-":
                cwd = enter(cwd, args[-1])
            elif name == "git" or name.startswith("git-"):
                rule = git_rule([name[4:], *args] if name != "git" else args, cwd, self.protected, self.branch)
            elif name == "gh":
                rule = gh_rule(args)
            if rule:
                yield rule
            for inner in nested_texts(name, args):
                yield from self.hits(inner, cwd, depth + 1)
            stdin_shell = stdin_shell or reads_stdin(name, args)
        for inner in stdin_feed(parts) if stdin_shell else []:
            yield from self.hits(inner, cwd, depth + 1)

    def scan(self, text: str, cwd: str) -> Iterator[str]:
        """Rules found by a conservative scan of text the tokeniser cannot read, with its quotes removed."""
        flat = re.sub(r"['\"]", "", text)
        for rule, pattern in TEXT_RULES:
            if pattern.search(flat):
                yield rule
        if GIT_PUSH.search(flat):
            names = "|".join(map(re.escape, self.protected))
            named = bool(names) and re.search(rf"(?:\s|:|heads/)(?:{names})(?![\w./-])", flat)
            if named or self.branch(cwd) in self.protected:
                yield "G3"


# Reading shell text

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


# Finding the command a simple command runs

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


def enter(cwd: str, target: str) -> str:
    """The directory that cd or git -C reaches from cwd, reading Git Bash's /c/... as c:/... on Windows."""
    if os.name == "nt":
        target = re.sub(r"^/([A-Za-z])(?:/|$)", r"\1:/", target)
    return os.path.join(cwd, os.path.expanduser(target))


def disables_husky(word: str) -> bool:
    match = ASSIGNMENT.fullmatch(word)
    return bool(match) and match[1].upper() == "HUSKY" and match[2] == "0"


def abbreviates(longs: list[str], *names: str) -> bool:
    """True when a long option given is one of the names, or an abbreviation of one that git accepts."""
    return any(given and name.startswith(given) for given in longs for name in names)


# The git rules, G1 to G5

def git_rule(args: list[str], cwd: str, protected: tuple[str, ...], branch: Callable[[str], str | None]) -> str | None:
    """The rule a git command breaks, if any."""
    directory, configs, index = cwd, [], 0
    while index < len(args) and args[index].startswith("-"):
        option, equals, value = args[index].partition("=")
        if option in GIT_VALUE_OPTIONS and not equals:
            index += 1
            value = args[index] if index < len(args) else ""
        if option == "-C":
            directory = enter(directory, value)
        elif option in ("-c", "--config-env"):
            configs.append(value)
        index += 1
    subcommand, rest = (args[index], args[index + 1:]) if index < len(args) else ("", [])
    rule = push_rule(rest, directory, protected, branch) if subcommand == "push" else None
    if rule:
        return rule
    commit = subcommand == "commit"
    letters, longs, operands = parse_options(rest, "mFCct" if commit else "", "uS" if commit else "")
    if abbreviates(longs, "no-verify") or (commit and "n" in letters):
        return "G4"
    if any(config.partition("=")[0].lower() == "core.hookspath" for config in configs):
        return "G4"
    if subcommand == "config" and any(operand.lower() == "core.hookspath" for operand in operands):
        return "G4"
    return "G5" if subcommand in ("filter-branch", "filter-repo") else None


def push_rule(args: list[str], directory: str, protected: tuple[str, ...],
              branch: Callable[[str], str | None]) -> str | None:
    """The rule a git push breaks, if any: G1, G2 or G3."""
    letters, longs, operands = parse_options(args, values="o", value_longs=PUSH_VALUE_OPTIONS)
    refspecs = operands[1:]  # the first operand is the remote
    if "f" in letters or abbreviates(longs, "force", "force-with-lease", "force-if-includes", "mirror") \
            or any(refspec.startswith("+") for refspec in refspecs):
        return "G1"
    if "d" in letters or abbreviates(longs, "delete", "prune") or any(refspec.startswith(":") for refspec in refspecs):
        return "G2"
    if abbreviates(longs, "all", "branches") or any(is_protected(destination(r), protected) for r in refspecs):
        return "G3"
    # With no refspec git pushes the current branch; --tags alone pushes only tags.
    uses_current = (not refspecs and "tags" not in longs) or any(destination(r) in ("HEAD", "@") for r in refspecs)
    return "G3" if uses_current and branch(directory) in protected else None


def destination(refspec: str) -> str:
    """The remote ref a push refspec writes: the part after the colon, or the source when there is none."""
    source, _, target = refspec.lstrip("+").partition(":")
    return target or source


def is_protected(ref: str, protected: tuple[str, ...]) -> bool:
    """True when a pushed-to ref, which may be a refspec pattern, names a protected branch."""
    name = ref.removeprefix("refs/").removeprefix("heads/")
    return any(fnmatch.fnmatchcase(branch, name) for branch in protected)


# The gh rules, G6 to G8

def gh_rule(args: list[str]) -> str | None:
    """The rule a gh command breaks, if any."""
    letters, longs, operands = parse_options(args, values="bFR", value_longs=("repo", "body", "body-file"))
    group, command = (operands + ["", ""])[:2]
    if group == "api":
        return api_rule(args[args.index("api") + 1:])
    if (group, command) == ("pr", "merge"):
        return "G7"
    if (group, command) == ("pr", "review") and ("a" in letters or "approve" in longs):
        return "G7"
    return "G8" if (group, command) in GH_SETTINGS else None


def api_rule(args: list[str]) -> str | None:
    """The rule a gh api call breaks, if any: G6, G7 or G8."""
    method, path = api_call(args)
    if method == "DELETE" and "/git/refs/" in f"/{path}/":
        return "G6"
    if method == "GET":
        return None
    if path.endswith(("/merge", "/merges")):
        return "G7"
    if any(fragment in f"/{path}" for fragment in SETTINGS_PATHS) or re.fullmatch(r"repos/[^/]+/[^/]+", path):
        return "G8"
    return None


def api_call(args: list[str]) -> tuple[str, str]:
    """The HTTP method and the endpoint path, without host, query or outer slashes, of a gh api call."""
    method, fields, operands, index = "", False, [], 0
    while index < len(args):
        arg = args[index]
        index += 1
        if not arg.startswith("-"):
            operands.append(arg)
            continue
        option, _, value = arg.partition("=") if arg.startswith("--") else (arg[:2], "", arg[2:])
        if option in API_VALUE_OPTIONS and not value and "=" not in arg:
            value = args[index] if index < len(args) else ""
            index += 1
        if option in ("-X", "--method"):
            method = value.upper()
        fields = fields or option in API_FIELD_OPTIONS
    path = re.sub(r"^[a-z]+://[^/]+", "", operands[0] if operands else "", flags=re.IGNORECASE)
    return method or ("POST" if fields else "GET"), path.split("?")[0].strip("/").removeprefix("api/v3/")


# Running as a hook

def protected_branches() -> tuple[str, ...]:
    """The configured protected branches, or main and master when the configuration cannot be read."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.append(str(REPO_ROOT))
    try:
        from factory.config import load
        return load().protected_branches
    except Exception:  # whatever is wrong with the configuration, a guard that crashes would let the command through
        return FALLBACK_PROTECTED


def current_branch(directory: str) -> str | None:
    """The branch checked out in a directory; None for a detached HEAD, no repository, or no git."""
    try:
        result = subprocess.run(["git", "-C", directory, "symbolic-ref", "--quiet", "--short", "HEAD"],
                                stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=5)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None
    branch = result.stdout.strip()
    return branch if result.returncode == 0 and branch else None


def main() -> NoReturn:
    data = hooklib.read_input()
    tool_input = data.get("tool_input")
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(command, str):
        hooklib.emit(Decision("allow"))
    cwd = data.get("cwd")
    context = {"cwd": cwd if isinstance(cwd, str) and cwd else str(hooklib.project_dir(data)),
               "factory_run": hooklib.is_factory_run(), "protected": protected_branches(),
               "current_branch": current_branch}
    try:
        decision = decide(command, **context)
    except Exception:  # a guard that crashes lets the command through, so fall back to the plain text scan
        try:
            decision = scan_text(command, **context)
        except Exception:
            decision = Decision("deny", reason("uninspectable"))
    hooklib.emit(decision)


if __name__ == "__main__":
    main()

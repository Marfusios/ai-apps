"""PreToolUse hook: refuse shell commands that break the repository's git rules."""

import fnmatch
import re
import subprocess
import sys
from collections.abc import Callable, Iterable, Iterator, Sequence
from pathlib import Path
from typing import NoReturn

import hooklib
import shell_words
from hooklib import Decision
from shell_words import parse_options

REPO_ROOT = Path(__file__).resolve().parents[2]
FALLBACK_PROTECTED = ("main", "master")
MAX_DEPTH = 5
REASONS = {
    "G1": "Force pushing is refused: it rewrites history others may have. Push new commits on top instead.",
    "G2": "Deleting remote branches or tags is refused. Leave them in place and tell the person which are no longer needed.",
    "G3": "Pushing to a protected branch such as main is refused. Push your own branch and open a pull request.",
    "G4": "Skipping git hooks is refused. Let the hooks run and fix what they report.",
    "G5": "Rewriting history with filter-branch or filter-repo is refused. Fix the problem in a new commit, or ask the person.",
    "G6": "Deleting or moving a branch or tag through the GitHub API is refused, as moving one is a force push by "
          "another name. Push new commits on top, or leave it in place and tell the person.",
    "G7": "Merging or approving a pull request is the person's decision. Leave the pull request open for their review.",
    "G8": "Changing repository settings, rules, secrets or workflows is the person's decision. Ask them to make the change.",
    "nesting": "The command nests shells more than five levels deep, too deep to inspect. Run the inner command directly.",
    "uninspectable": "The git guard could not inspect this command. Run it in a simpler form.",
}
ASK_WHEN_INTERACTIVE = {"G7", "G8"}

HUSKY_OFF = re.compile(r"(?:\$env:)?husky=0", re.IGNORECASE | re.DOTALL)
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
GRAPHQL_REF_MUTATIONS = ("deleteRef", "updateRef")
GRAPHQL_MERGE_MUTATIONS = ("mergePullRequest", "enablePullRequestAutoMerge")
GRAPHQL_SETTINGS_MUTATIONS = tuple(f"{verb}{noun}" for noun in ("BranchProtectionRule", "RepositoryRuleset")
                                   for verb in ("create", "update", "delete"))


def graphql_pattern(names: tuple[str, ...]) -> str:
    """A text pattern for gh api graphql with one of the mutation names, which GraphQL spells case-sensitively."""
    return r"\bgh\b.*\bapi\b.*\bgraphql\b.*(?-i:\b(?:" + "|".join(names) + r")\b)"


GIT_PUSH = re.compile(r"\bgit\b.*\bpush\b", re.IGNORECASE | re.DOTALL)
TEXT_RULES = [(rule, re.compile(pattern, re.IGNORECASE | re.DOTALL)) for rule, pattern in (
    ("G1", GIT_PUSH.pattern + r".*(?:--force|--mirror|\s-\w*f|\s\+)"),
    ("G2", GIT_PUSH.pattern + r".*(?:--delete|--prune|\s-\w*d|\s:)"),
    ("G3", GIT_PUSH.pattern + r".*--(?:all|branches)\b"),
    ("G4", r"--no-verify|core\.hookspath|\bhusky=0|\bgit\b.*\bcommit\b.*\s-\w*n"),
    ("G5", r"\bgit\b.*\bfilter-(?:branch|repo)\b"),
    ("G6", r"\bgh\b.*\bapi\b(?=.*(?:\b(?:delete|patch)\b|-x(?:delete|patch))).*/git/refs/"),
    ("G6", graphql_pattern(GRAPHQL_REF_MUTATIONS)),
    ("G7", graphql_pattern(GRAPHQL_MERGE_MUTATIONS)),
    ("G8", graphql_pattern(GRAPHQL_SETTINGS_MUTATIONS)),
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
    inspection = Inspection(protected, current_branch)
    return verdict((rule for text in shell_words.variants(command) for rule in inspection.hits(text, cwd)), factory_run)


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
        text = shell_words.unfold(text)
        try:
            script = shell_words.parse(text)
        except ValueError:
            yield from self.scan(text, cwd)
            return
        for inner in script.substitutions:
            yield from self.hits(inner, cwd, depth + 1)
        for command in script.commands:
            name, args = command.name, command.args
            if any(disables_husky(word) for word in command.assignments + (args if name == "export" else [])):
                yield "G4"
            rule = None
            if name in ("cd", "pushd") and args and args[-1] != "-":
                cwd = shell_words.enter(cwd, args[-1])
            elif name == "git" or name.startswith("git-"):
                rule = git_rule([name[4:], *args] if name != "git" else args, cwd, self.protected, self.branch)
            elif name == "gh":
                rule = gh_rule(args)
            if rule:
                yield rule
            for inner in command.nested:
                yield from self.hits(inner, cwd, depth + 1)
        for inner in script.stdin_texts:
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


def disables_husky(word: str) -> bool:
    return bool(HUSKY_OFF.fullmatch(word))


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
            directory = shell_words.enter(directory, value)
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
    if path == "graphql":
        return graphql_rule(" ".join(args))
    if method in ("DELETE", "PATCH") and "/git/refs/" in f"/{path}/":
        return "G6"
    if method == "GET":
        return None
    if path.endswith(("/merge", "/merges")):
        return "G7"
    if any(fragment in f"/{path}" for fragment in SETTINGS_PATHS) or re.fullmatch(r"repos/[^/]+/[^/]+", path):
        return "G8"
    return None


def graphql_rule(text: str) -> str | None:
    """The rule a gh api graphql call breaks, judged by the mutation names anywhere in its text."""
    for rule, names in (("G6", GRAPHQL_REF_MUTATIONS), ("G7", GRAPHQL_MERGE_MUTATIONS),
                        ("G8", GRAPHQL_SETTINGS_MUTATIONS)):
        if re.search(r"\b(?:" + "|".join(names) + r")\b", text):
            return rule
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

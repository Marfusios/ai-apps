"""Turn the repository's Claude Code settings into managed settings that a file in a repository cannot override."""

import copy
from collections.abc import Mapping

HARNESS_ROOT = "/opt/factory/harness"
PROJECT_PREFIX = 'sh "$CLAUDE_PROJECT_DIR/.claude/hooks/run" '
# The interpreter is named so that a hook never depends on what the run's PATH offers; /bin/sh likewise.
IMAGE_PREFIX = f"FACTORY_HOOK_PYTHON=/usr/bin/python3 /bin/sh {HARNESS_ROOT}/.claude/hooks/run "
EXPECTED_HOOKS = frozenset({"guard_git", "guard_paths", "guard_quality", "finish_check"})
REQUIRED_EVENTS = ("PreToolUse", "Stop")


def _hooks(project_settings: Mapping) -> dict:
    """The project's hooks with every command pointed at the image's copy of the launcher.

    Raises ValueError unless the hooks are exactly the guards that EXPECTED_HOOKS names, with at least one
    under each of REQUIRED_EVENTS: a guard removed from the settings must fail the build, not ship silently.
    """
    hooks = copy.deepcopy(project_settings.get("hooks"))
    if not isinstance(hooks, dict) or not hooks:
        raise ValueError("the settings have no hooks, and a factory run must not start without its guards")
    names: set[str] = set()
    for event, groups in hooks.items():
        if not isinstance(groups, list) or not all(isinstance(group, dict) for group in groups):
            raise ValueError(f"the {event} hooks are not a list of objects")
        if not all(isinstance(group.get("hooks", []), list) for group in groups):
            raise ValueError(f"a {event} group has hooks that are not a list")
        commands = [hook for group in groups for hook in group.get("hooks", [])]
        if not commands:
            raise ValueError(f"the {event} hooks list no command")
        for hook in commands:
            command = hook.get("command") if isinstance(hook, dict) else None
            if not isinstance(command, str) or not command.startswith(PROJECT_PREFIX):
                raise ValueError(f"a {event} hook command does not start with {PROJECT_PREFIX}")
            names.add(command[len(PROJECT_PREFIX):])
            hook["command"] = IMAGE_PREFIX + command[len(PROJECT_PREFIX):]
    for event in REQUIRED_EVENTS:
        if event not in hooks:
            raise ValueError(f"the settings have no {event} hook")
    if names != EXPECTED_HOOKS:
        missing, extra = sorted(EXPECTED_HOOKS - names), sorted(names - EXPECTED_HOOKS)
        raise ValueError(f"the hooks are not the expected guards: missing {missing}, unexpected {extra}")
    return hooks


def build(project_settings: Mapping) -> dict:
    """The managed settings: the hooks of the image, and every ask rule turned into a deny rule.

    Nobody can answer a question in a factory run, so a rule that asks would be a rule that fails.
    """
    permissions = project_settings.get("permissions", {})
    rules = [*permissions.get("deny", []), *permissions.get("ask", [])]
    return {
        "allowManagedHooksOnly": True,
        "hooks": _hooks(project_settings),
        "permissions": {"deny": list(dict.fromkeys(rules))},
    }

"""Turn the repository's Claude Code settings into managed settings that a file in a repository cannot override."""

import copy
from collections.abc import Mapping

HARNESS_ROOT = "/opt/factory/harness"
PROJECT_LAUNCHER = '"$CLAUDE_PROJECT_DIR/.claude/hooks/run"'
IMAGE_LAUNCHER = f"{HARNESS_ROOT}/.claude/hooks/run"


def _hooks(project_settings: Mapping) -> dict:
    """The project's hooks with every command pointed at the image's copy of the launcher."""
    hooks = copy.deepcopy(project_settings.get("hooks"))
    if not isinstance(hooks, dict) or not hooks:
        raise ValueError("the settings have no hooks, and a factory run must not start without its guards")
    for event, groups in hooks.items():
        commands = [hook for group in groups for hook in group.get("hooks", [])]
        if not commands:
            raise ValueError(f"the {event} hooks list no command")
        for hook in commands:
            command = hook.get("command")
            if not isinstance(command, str) or PROJECT_LAUNCHER not in command:
                raise ValueError(f"a {event} hook command does not run {PROJECT_LAUNCHER}")
            hook["command"] = command.replace(PROJECT_LAUNCHER, IMAGE_LAUNCHER)
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

"""Load a Claude Code hook script as a module, so tests can call its functions directly."""

import importlib.util
import sys
from pathlib import Path
from types import ModuleType

HOOKS_DIR = Path(__file__).resolve().parents[2] / ".claude" / "hooks"


def load_hook(name: str) -> ModuleType:
    """Import `.claude/hooks/<name>.py` by path, with the hooks directory importable as when it runs as a script."""
    if str(HOOKS_DIR) not in sys.path:
        sys.path.insert(0, str(HOOKS_DIR))
    spec = importlib.util.spec_from_file_location(name, HOOKS_DIR / f"{name}.py")
    if spec is None or spec.loader is None:
        raise ImportError(f"cannot load hook {name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module

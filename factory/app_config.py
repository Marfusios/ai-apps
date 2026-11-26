"""Validation of an app's factory.toml, collecting every problem at once."""

import re
import tomllib
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path

MAX_COMMAND = 500
MAX_SERVICES = 4
MAX_MEMORY_MB = 4096
TOOLCHAIN_KEYS = ("node", "python")
QUALITY_KEYS = ("format", "lint", "types", "tests")
TOP_KEYS = {"schema", "toolchain", "commands", "quality", "services"}
COMMAND_KEYS = {"setup", "check", "quick"}
SERVICE_KEYS = {"name", "image", "env", "ready", "memory"}


class AppConfigError(ValueError):
    """factory.toml is missing, unparsable, or breaks the schema."""

    def __init__(self, problems: list[str]):
        super().__init__("; ".join(problems))
        self.problems = problems


@dataclass(frozen=True)
class Service:
    name: str
    image: str
    env: dict[str, str]
    ready: str
    memory: str


@dataclass(frozen=True)
class AppConfig:
    toolchain: dict[str, str]
    setup: str
    check: str
    quick: str | None
    quality: dict[str, str]
    services: tuple[Service, ...]


def _single_line(value: object, limit: int | None = None) -> str | None:
    """Return a problem description, or None when the value is a usable single-line string."""
    if not isinstance(value, str) or not value.strip():
        return "must be a non-empty string"
    if "\n" in value or "\r" in value:
        return "must be a single line"
    if limit is not None and len(value) > limit:
        return f"must be at most {limit} characters"
    return None


def _table(value: object, path: str, problems: list[str]) -> dict:
    if isinstance(value, dict):
        return value
    problems.append(f"{path}: must be a table")
    return {}


def _unknown(table: dict, allowed: set[str], path: str, problems: list[str]) -> None:
    for key in table:
        if key not in allowed:
            problems.append(f"{path}.{key}: unknown key" if path else f"{key}: unknown key")


def _command(table: dict, key: str, required: bool, problems: list[str]) -> str | None:
    if key not in table:
        if required:
            problems.append(f"commands.{key}: required")
        return None
    problem = _single_line(table[key], MAX_COMMAND)
    if problem:
        problems.append(f"commands.{key}: {problem}")
        return None
    return table[key]


def _quality(raw: object, problems: list[str]) -> dict[str, str]:
    table = _table(raw, "quality", problems)
    _unknown(table, set(QUALITY_KEYS), "quality", problems)
    result: dict[str, str] = {}
    for key in QUALITY_KEYS:
        value = table.get(key)
        if key not in table:
            problems.append(f"quality.{key}: required")
        elif not isinstance(value, str) or not value.strip() or "\n" in value or "\r" in value:
            problems.append(f"quality.{key}: must be a single-line tool name or 'none: <reason>'")
        elif (value == "none" or value.startswith("none:")) and not re.fullmatch(r"none: .{10,}", value):
            problems.append(f"quality.{key}: 'none' needs a reason of at least 10 characters, as 'none: <reason>'")
        else:
            result[key] = value
    return result


def _toolchain(raw: object, problems: list[str]) -> dict[str, str]:
    table = _table(raw, "toolchain", problems)
    result: dict[str, str] = {}
    for key, value in table.items():
        if key not in TOOLCHAIN_KEYS:
            problems.append(f"toolchain.{key}: unknown key")
        elif not isinstance(value, str) or not re.fullmatch(r"\d+(\.\d+){0,2}", value):
            problems.append(f"toolchain.{key}: must be a version such as '22' or '3.12'")
        else:
            result[key] = value
    return result


def _memory_ok(value: object) -> bool:
    match = re.fullmatch(r"(\d+)([mg])", value) if isinstance(value, str) else None
    if not match:
        return False
    megabytes = int(match.group(1)) * (1024 if match.group(2) == "g" else 1)
    return 0 < megabytes <= MAX_MEMORY_MB


def _image_ok(image: object, registries: Sequence[str]) -> bool:
    if not isinstance(image, str) or not any(image.startswith(r) for r in registries):
        return False
    name = image.rsplit("/", 1)[-1]
    return bool(re.search(r":[^:@]+$", name) or re.search(r"@sha256:[0-9a-f]{64}$", name))


def _service(raw: object, index: int, registries: Sequence[str], seen: set[str], problems: list[str]) -> Service | None:
    path = f"services[{index}]"
    table = _table(raw, path, problems)
    before = len(problems)
    _unknown(table, SERVICE_KEYS, path, problems)
    name = table.get("name")
    if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9-]{0,30}", name):
        problems.append(f"{path}.name: must match [a-z][a-z0-9-]{{0,30}}")
    elif name in seen:
        problems.append(f"{path}.name: duplicate service name '{name}'")
    else:
        seen.add(name)
    if not _image_ok(table.get("image"), registries):
        problems.append(f"{path}.image: must start with a configured registry and carry a tag or digest")
    env = table.get("env", {})
    if not isinstance(env, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in env.items()):
        problems.append(f"{path}.env: must be a table of strings")
    problem = _single_line(table.get("ready"))
    if problem:
        problems.append(f"{path}.ready: {problem}")
    if not _memory_ok(table.get("memory")):
        problems.append(f"{path}.memory: must look like '512m' or '2g' and be at most 4g")
    if len(problems) > before:
        return None
    return Service(name, table["image"], dict(env), table["ready"], table["memory"])


def _validate(data: dict, registries: Sequence[str]) -> tuple[AppConfig | None, list[str]]:
    problems: list[str] = []
    _unknown(data, TOP_KEYS, "", problems)
    if data.get("schema") != 1 or isinstance(data.get("schema"), bool):
        problems.append("schema: must be 1")
    toolchain = _toolchain(data.get("toolchain", {}), problems)
    commands = _table(data.get("commands"), "commands", problems) if "commands" in data else {}
    if "commands" not in data:
        problems.append("commands: required")
    _unknown(commands, COMMAND_KEYS, "commands", problems)
    setup = _command(commands, "setup", True, problems) if "commands" in data else None
    check = _command(commands, "check", True, problems) if "commands" in data else None
    quick = _command(commands, "quick", False, problems)
    quality = _quality(data["quality"], problems) if "quality" in data else (
        problems.append("quality: required") or {})
    raw_services = data.get("services", [])
    services: list[Service] = []
    if not isinstance(raw_services, list):
        problems.append("services: must be an array of tables")
    else:
        if len(raw_services) > MAX_SERVICES:
            problems.append(f"services: at most {MAX_SERVICES} services")
        seen: set[str] = set()
        for index, raw in enumerate(raw_services):
            service = _service(raw, index, registries, seen, problems)
            if service:
                services.append(service)
    if problems:
        return None, problems
    return AppConfig(toolchain, setup, check, quick, quality, tuple(services)), []


def load(app_dir: Path, registries: Sequence[str]) -> AppConfig:
    """Read and validate <app_dir>/factory.toml; raise AppConfigError listing every problem."""
    path = app_dir / "factory.toml"
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise AppConfigError([f"factory.toml: cannot read: {error}"]) from error
    config, problems = _validate(data, registries)
    if config is None:
        raise AppConfigError(problems)
    return config

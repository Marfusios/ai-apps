"""Repository-wide factory configuration, read from config.toml."""

import re
import tomllib
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from factory.app_config import TOOLCHAIN_KEYS
from factory.result import STAGES

DEFAULT_PATH = Path(__file__).with_name("config.toml")
APPLIED_BY = ("person", "dispatcher")
KEYS = {"schema", "trusted_logins", "writable_paths", "protected_branches", "image_registries", "labels",
        "dispatcher", "agent", "stages"}
LABEL_KEYS = {"name", "color", "description", "applied_by"}
# key -> (lowest, highest) accepted value
DISPATCHER_LIMITS = {
    "poll_seconds": (15, 600),
    "usage_limit_backoff_minutes": (5, 720),
    "max_bundle_megabytes": (1, 500),
    "max_file_megabytes": (1, 100),
    "max_commits": (1, 500),
}
STAGE_LIMITS = {"timeout_minutes": (5, 360), "max_turns": (10, 1000)}
STAGE_KEYS = {"model", *STAGE_LIMITS}
REQUIRED_STAGE = "fix_issue"  # the stage the dispatcher starts runs in
AGENT_KEYS = {"permission_mode", "claude_code_version", "base_image", "toolchains"}
PERMISSION_MODES = ("auto", "bypassPermissions")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")  # explicit [0-9]: \d would accept other scripts' digits
MODEL = re.compile(r"[a-z0-9][a-z0-9.-]{0,63}")


class ConfigError(ValueError):
    """The factory configuration file is missing or malformed."""


@dataclass(frozen=True)
class Label:
    name: str
    color: str
    description: str
    applied_by: str


@dataclass(frozen=True)
class DispatcherSettings:
    poll_seconds: int
    usage_limit_backoff_minutes: int
    max_bundle_megabytes: int
    max_file_megabytes: int
    max_commits: int


@dataclass(frozen=True)
class AgentSettings:
    permission_mode: str
    claude_code_version: str
    base_image: str
    toolchains: Mapping[str, tuple[str, ...]]


@dataclass(frozen=True)
class StageSettings:
    model: str
    timeout_minutes: int
    max_turns: int


@dataclass(frozen=True)
class Config:
    trusted_logins: tuple[str, ...]
    writable_paths: tuple[str, ...]
    protected_branches: tuple[str, ...]
    image_registries: tuple[str, ...]
    labels: tuple[Label, ...]
    dispatcher: DispatcherSettings
    agent: AgentSettings
    stages: Mapping[str, StageSettings]


def _strings(data: dict, key: str) -> tuple[str, ...]:
    value = data.get(key)
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
        raise ConfigError(f"{key} must be a non-empty list of non-empty strings")
    return tuple(value)


def _trusted_logins(data: dict) -> tuple[str, ...]:
    logins = _strings(data, "trusted_logins")
    if any(login.lower().endswith("[bot]") for login in logins):
        raise ConfigError("trusted_logins must not hold a bot account: a bot account cannot be trusted")
    return logins


def _prefixes(data: dict, key: str) -> tuple[str, ...]:
    values = _strings(data, key)
    if not all(v.endswith("/") for v in values):
        raise ConfigError(f"every entry of {key} must end with '/'")
    return values


def _table(raw: object, where: str, keys: set[str]) -> dict:
    if not isinstance(raw, dict):
        raise ConfigError(f"{where} must be a table")
    for key in sorted(keys - set(raw)):
        raise ConfigError(f"{where}.{key} is required")
    for key in sorted(set(raw) - keys):
        raise ConfigError(f"{where}.{key} is not a known key")
    return raw


def _integers(table: dict, where: str, limits: dict[str, tuple[int, int]]) -> dict[str, int]:
    for key, (low, high) in limits.items():
        value = table[key]
        if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
            raise ConfigError(f"{where}.{key} must be an integer from {low} to {high}")
    return {key: table[key] for key in limits}


def _dispatcher(raw: object) -> DispatcherSettings:
    table = _table(raw, "dispatcher", set(DISPATCHER_LIMITS))
    return DispatcherSettings(**_integers(table, "dispatcher", DISPATCHER_LIMITS))


def _toolchains(raw: object) -> dict[str, tuple[str, ...]]:
    where = "agent.toolchains"
    if not isinstance(raw, dict) or not raw or not set(raw) <= set(TOOLCHAIN_KEYS):
        raise ConfigError(f"{where} must be a non-empty table with keys from {TOOLCHAIN_KEYS}")
    for key, versions in raw.items():
        if not isinstance(versions, list) or not versions or not all(isinstance(v, str) and v for v in versions):
            raise ConfigError(f"{where}.{key} must be a non-empty list of non-empty strings")
    return {key: tuple(versions) for key, versions in raw.items()}


def _agent(raw: object, registries: tuple[str, ...]) -> AgentSettings:
    table = _table(raw, "agent", AGENT_KEYS)
    if table["permission_mode"] not in PERMISSION_MODES:
        raise ConfigError(f"agent.permission_mode must be one of {PERMISSION_MODES}")
    version = table["claude_code_version"]
    if not isinstance(version, str) or not VERSION.fullmatch(version):
        raise ConfigError("agent.claude_code_version must be three dot-separated numbers such as 2.1.332")
    image = table["base_image"]
    if not isinstance(image, str) or not image.startswith(registries):
        raise ConfigError(f"agent.base_image must start with one of image_registries {registries}")
    return AgentSettings(table["permission_mode"], version, image, _toolchains(table["toolchains"]))


def _stage(name: str, raw: object) -> StageSettings:
    where = f"stages.{name}"
    if name not in STAGES:
        raise ConfigError(f"{where}: the stage name must be one of {STAGES}")
    table = _table(raw, where, STAGE_KEYS)
    model = table["model"]
    if not isinstance(model, str) or not MODEL.fullmatch(model):
        raise ConfigError(f"{where}.model must match {MODEL.pattern}")
    return StageSettings(model, **_integers(table, where, STAGE_LIMITS))


def _stages(raw: object) -> dict[str, StageSettings]:
    if not isinstance(raw, dict) or not raw:
        raise ConfigError("stages must be a table with at least one stage")
    stages = {name: _stage(name, table) for name, table in raw.items()}
    if REQUIRED_STAGE not in stages:
        raise ConfigError(f"stages.{REQUIRED_STAGE} is required")
    return stages


def _label(raw: object, index: int) -> Label:
    where = f"labels[{index}]"
    if not isinstance(raw, dict) or set(raw) != LABEL_KEYS:
        raise ConfigError(f"{where} must have exactly the keys {sorted(LABEL_KEYS)}")
    if not all(isinstance(raw[k], str) for k in LABEL_KEYS):
        raise ConfigError(f"{where} values must be strings")
    if not raw["name"]:
        raise ConfigError(f"{where}.name must not be empty")
    if not re.fullmatch(r"[0-9a-fA-F]{6}", raw["color"]):
        raise ConfigError(f"{where}.color must be six hexadecimal digits without '#'")
    if not 0 < len(raw["description"]) <= 100:
        raise ConfigError(f"{where}.description must be 1 to 100 characters")
    if raw["applied_by"] not in APPLIED_BY:
        raise ConfigError(f"{where}.applied_by must be one of {APPLIED_BY}")
    return Label(raw["name"], raw["color"], raw["description"], raw["applied_by"])


def load(path: Path | None = None) -> Config:
    """Read and validate the configuration; the default file sits beside this module."""
    path = path or DEFAULT_PATH
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError, RecursionError) as error:
        raise ConfigError(f"cannot read {path.name}: {error}") from error
    if data.get("schema") != 1 or isinstance(data.get("schema"), bool):
        raise ConfigError("schema must be 1")
    unknown = set(data) - KEYS
    if unknown:
        raise ConfigError(f"unknown keys: {sorted(unknown)}")
    raw_labels = data.get("labels")
    if not isinstance(raw_labels, list) or not raw_labels:
        raise ConfigError("labels must be a non-empty array of tables")
    labels = tuple(_label(raw, i) for i, raw in enumerate(raw_labels))
    names = [label.name for label in labels]
    repeated = sorted({name for name in names if names.count(name) > 1})
    if repeated:
        raise ConfigError(f"label names must be unique, repeated: {repeated}")
    image_registries = _prefixes(data, "image_registries")
    return Config(
        trusted_logins=_trusted_logins(data),
        writable_paths=_prefixes(data, "writable_paths"),
        protected_branches=_strings(data, "protected_branches"),
        image_registries=image_registries,
        labels=labels,
        dispatcher=_dispatcher(data.get("dispatcher")),
        agent=_agent(data.get("agent"), image_registries),
        stages=_stages(data.get("stages")),
    )


def is_trusted(login: str, config: Config) -> bool:
    """True when the login is a trusted one; GitHub logins are case-insensitive."""
    return bool(login) and login.lower() in {trusted.lower() for trusted in config.trusted_logins}


def is_writable(relative_path: str, config: Config) -> bool:
    """True when an agent may write to this repository-relative path."""
    path = relative_path.replace("\\", "/")
    if not path or path.startswith("/") or re.match(r"[A-Za-z]:", path):
        return False
    if ".." in path.split("/"):
        return False
    return any(path.startswith(prefix) and len(path) > len(prefix) for prefix in config.writable_paths)

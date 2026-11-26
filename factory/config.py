"""Repository-wide factory configuration, read from config.toml."""

import re
import tomllib
from dataclasses import dataclass
from pathlib import Path

DEFAULT_PATH = Path(__file__).with_name("config.toml")
APPLIED_BY = ("person", "dispatcher")
KEYS = {"schema", "trusted_logins", "writable_paths", "protected_branches", "image_registries", "labels"}
LABEL_KEYS = {"name", "color", "description", "applied_by"}


class ConfigError(ValueError):
    """The factory configuration file is missing or malformed."""


@dataclass(frozen=True)
class Label:
    name: str
    color: str
    description: str
    applied_by: str


@dataclass(frozen=True)
class Config:
    trusted_logins: tuple[str, ...]
    writable_paths: tuple[str, ...]
    protected_branches: tuple[str, ...]
    image_registries: tuple[str, ...]
    labels: tuple[Label, ...]


def _strings(data: dict, key: str) -> tuple[str, ...]:
    value = data.get(key)
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
        raise ConfigError(f"{key} must be a non-empty list of non-empty strings")
    return tuple(value)


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
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as error:
        raise ConfigError(f"cannot read {path.name}: {error}") from error
    if data.get("schema") != 1 or isinstance(data.get("schema"), bool):
        raise ConfigError("schema must be 1")
    unknown = set(data) - KEYS
    if unknown:
        raise ConfigError(f"unknown keys: {sorted(unknown)}")
    raw_labels = data.get("labels")
    if not isinstance(raw_labels, list) or not raw_labels:
        raise ConfigError("labels must be a non-empty array of tables")
    return Config(
        trusted_logins=_strings(data, "trusted_logins"),
        writable_paths=_strings(data, "writable_paths"),
        protected_branches=_strings(data, "protected_branches"),
        image_registries=_strings(data, "image_registries"),
        labels=tuple(_label(raw, i) for i, raw in enumerate(raw_labels)),
    )


def is_writable(relative_path: str, config: Config) -> bool:
    """True when an agent may write to this repository-relative path."""
    path = relative_path.replace("\\", "/")
    if not path or path.startswith("/") or re.match(r"[A-Za-z]:", path):
        return False
    if ".." in path.split("/"):
        return False
    return any(path.startswith(prefix) and len(path) > len(prefix) for prefix in config.writable_paths)

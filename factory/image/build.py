"""Build the agent image: assemble the build context from the checkout, digest the harness, run `podman build`."""

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Iterator, Sequence
from pathlib import Path

from factory.config import Config, ConfigError
from factory.config import load as load_config
from factory.image import managed_settings

IMAGE_LABEL = "factory.harness"
HARNESS_FILES = (
    ".claude/hooks/*",
    ".claude/settings.json",
    "factory/*.py",
    "factory/config.toml",
    "factory/image/Containerfile",
    "factory/image/*.py",
)
# what the copied hooks need to run: the hooks themselves, and the modules of the package they import
CONTEXT_FILES = (".claude/hooks/*", "factory/*.py", "factory/config.toml")
IMAGE_NAME = re.compile(r"[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?")  # never an option, never a space
ROOT = Path(__file__).resolve().parents[2]


def _matching(root: Path, patterns: Sequence[str]) -> Iterator[tuple[str, Path]]:
    """The files under root that match a pattern, as (relative path with forward slashes, path), sorted."""
    found: dict[str, Path] = {}
    for pattern in patterns:
        for path in root.glob(pattern):
            relative = path.relative_to(root)
            if path.is_file() and "__pycache__" not in relative.parts and path.suffix != ".pyc":
                found[relative.as_posix()] = path
    yield from sorted(found.items())


def _text(path: Path) -> bytes:
    """The file's bytes with LF line endings: a Windows checkout may hold CRLF, the repository stores LF."""
    return path.read_bytes().replace(b"\r\n", b"\n")


def harness_digest(root: Path) -> str:
    """SHA-256 over the relative path, length and content of every harness file, the same on every platform."""
    digest = hashlib.sha256()
    for relative, path in _matching(root, HARNESS_FILES):
        content = _text(path)
        digest.update(relative.encode("utf-8") + b"\0" + len(content).to_bytes(8, "big") + content)
    return digest.hexdigest()


def write_context(root: Path, dest: Path) -> None:
    """Lay out the build context in dest, which must be empty or absent: the Containerfile, the harness and settings."""
    if dest.exists() and any(dest.iterdir()):
        raise FileExistsError(f"the build context directory {dest} is not empty")
    dest.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / "factory" / "image" / "Containerfile", dest / "Containerfile")
    for relative, path in _matching(root, CONTEXT_FILES):
        target = dest / "harness" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(_text(path))
    project = json.loads((root / ".claude" / "settings.json").read_text(encoding="utf-8"))
    text = json.dumps(managed_settings.build(project), indent=2, sort_keys=True) + "\n"
    (dest / "managed-settings.json").write_bytes(text.encode("utf-8"))


def build_argv(context: Path, image: str, config: Config, digest: str) -> list[str]:
    return ["podman", "build",
            "--build-arg", f"BASE_IMAGE={config.agent.base_image}",
            "--build-arg", f"CLAUDE_CODE_VERSION={config.agent.claude_code_version}",
            "--label", f"{IMAGE_LABEL}={digest}",
            "-t", image, str(context)]


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="factory.image.build", description="Build the factory's agent image.")
    parser.add_argument("--print-digest", action="store_true",
                        help="print the digest of this checkout's harness and exit; the image name is not needed")
    args = parser.parse_args(argv)
    if args.print_digest:
        print(harness_digest(ROOT))
        return 0
    image = os.environ.get("FACTORY_IMAGE", "")
    if not image:
        print("FACTORY_IMAGE is missing: set it to the name the image is built under", file=sys.stderr)
        return 2
    if IMAGE_NAME.fullmatch(image) is None:
        print("FACTORY_IMAGE is malformed", file=sys.stderr)
        return 2
    try:
        config = load_config()
    except ConfigError as error:
        print(f"the factory configuration cannot be loaded: {error}", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="factory-image-") as holder:
        context = Path(holder) / "context"
        write_context(ROOT, context)
        try:
            return subprocess.run(build_argv(context, image, config, harness_digest(ROOT)), check=False).returncode
        except OSError as error:
            print(f"podman could not be started: {type(error).__name__}", file=sys.stderr)
            return 1


if __name__ == "__main__":
    sys.exit(main())

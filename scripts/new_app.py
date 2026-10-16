#!/usr/bin/env python3
"""Create an app documentation scaffold without choosing its implementation stack."""

import argparse
from pathlib import Path
import re
import shutil


ROOT = Path(__file__).resolve().parent.parent
CATALOG_MARKER = "<!-- app-catalog -->"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("name", help="App name in kebab-case, for example document-search")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*", args.name):
        parser.error("Use a lowercase name with letters, numbers, and single hyphens.")
    if len(args.name) > 64:
        parser.error("App names must be at most 64 characters long.")

    destination = ROOT / "apps" / args.name
    if destination.exists() or destination.is_symlink():
        parser.error(f"apps/{args.name} already exists; nothing was changed.")

    catalog_path = ROOT / "apps" / "README.md"
    catalog = catalog_path.read_text(encoding="utf-8")
    if catalog.count(CATALOG_MARKER) != 1:
        parser.error("The application catalog must contain exactly one app-catalog marker.")

    title = args.name.replace("-", " ").title()
    row = f"| [{title}]({args.name}/README.md) | Describe the app's purpose. | Scaffold |\n"
    updated_catalog = catalog.replace(CATALOG_MARKER, row + CATALOG_MARKER)
    shutil.copytree(ROOT / "templates" / "app", destination)
    readme_path = destination / "README.md"
    readme = readme_path.read_text(encoding="utf-8")
    readme = readme.replace("{{APP_TITLE}}", title).replace("{{APP_SLUG}}", args.name)
    readme_path.write_text(readme, encoding="utf-8")
    catalog_path.write_text(updated_catalog, encoding="utf-8")
    print(f"Created apps/{args.name}/ and registered it as a scaffold in apps/README.md.")
    print("Next: choose the app's stack and follow docs/development.md.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

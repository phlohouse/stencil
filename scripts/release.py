from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

VERSION_PATTERN = re.compile(r"^\d+\.\d+\.\d+$")
REPO_ROOT = Path(__file__).resolve().parent.parent


def _run(*args: str, capture_output: bool = False) -> str:
    completed = subprocess.run(
        args,
        cwd=REPO_ROOT,
        check=True,
        text=True,
        capture_output=capture_output,
    )
    return completed.stdout.strip() if capture_output else ""


def _fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def _validate_version(version: str) -> str:
    if not VERSION_PATTERN.fullmatch(version):
        raise ValueError(
            f"Invalid version '{version}'. Expected semantic version like 0.3.5."
        )
    return version


def _ensure_clean_worktree() -> None:
    status = _run("git", "status", "--short", capture_output=True)
    if status:
        raise RuntimeError("Worktree is dirty. Commit or stash changes before releasing.")


def _ensure_tag_absent(tag: str) -> None:
    existing_local = _run("git", "tag", "--list", tag, capture_output=True)
    if existing_local:
        raise RuntimeError(f"Tag '{tag}' already exists locally.")

    existing_remote = _run(
        "git",
        "ls-remote",
        "--tags",
        "origin",
        f"refs/tags/{tag}",
        capture_output=True,
    )
    if existing_remote:
        raise RuntimeError(f"Tag '{tag}' already exists on origin.")


def main(argv: list[str]) -> int:
    if len(argv) != 2 or not argv[1]:
        return _fail("Usage: python3 scripts/release.py 0.3.5")

    try:
        version = _validate_version(argv[1])
        tag = f"v{version}"
        _ensure_clean_worktree()
        _ensure_tag_absent(tag)
        _run("git", "tag", "-a", tag, "-m", f"Release {tag}")
        _run("git", "push", "origin", "HEAD", tag)
    except (subprocess.CalledProcessError, RuntimeError, ValueError) as exc:
        return _fail(str(exc))

    print(f"Pushed {tag}. GitHub Actions will publish PyPI and create/update the GitHub release.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))

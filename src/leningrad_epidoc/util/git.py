from __future__ import annotations

import subprocess
from pathlib import Path


def repo_hash(cwd: Path | None = None) -> str:
    try:
        head = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if head.returncode != 0:
            return "unknown"
        sha = head.stdout.strip()
        if not sha:
            return "unknown"
        dirty = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if dirty.returncode == 0 and dirty.stdout.strip():
            return f"{sha}-dirty"
        return sha
    except Exception:
        return "unknown"


def file_is_dirty(path: Path | str, cwd: Path | None = None) -> bool:
    try:
        proc = subprocess.run(
            ["git", "status", "--porcelain", "--", str(path)],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if proc.returncode != 0:
            return False
        return bool(proc.stdout.strip())
    except Exception:
        return False


def require_file_clean(path: Path | str, cwd: Path | None = None) -> None:
    if file_is_dirty(path, cwd):
        raise RuntimeError(
            f"uncommitted changes to {path}: commit or revert before running align-folio"
        )

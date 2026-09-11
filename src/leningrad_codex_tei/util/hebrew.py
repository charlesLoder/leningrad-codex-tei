"""Hebrew text sequencing via the hebrew-transliteration Node library.

Requires Node.js plus ``npm install`` at the repo root. No Python fallback:
ordering consonant → dagesh → vowel → taam per the SBL Hebrew Font Manual
is owned by ``sequence()`` upstream; reimplementing it here would
recreate the wheel and risk drift.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT = REPO_ROOT / "scripts" / "sequence-hebrew.mjs"


class HebrewSequencingError(RuntimeError):
    pass


def _require_node() -> str:
    node = shutil.which("node")
    if node is None:
        raise HebrewSequencingError("Node.js is required but was not found on PATH.")
    if not SCRIPT.exists():
        raise HebrewSequencingError(f"Sequencing script not found: {SCRIPT}")
    if not (REPO_ROOT / "node_modules" / "hebrew-transliteration").exists():
        raise HebrewSequencingError(
            "hebrew-transliteration is not installed. Run `npm install` from the repo root."
        )
    return node


def sequence_texts(texts: list[str]) -> list[str]:
    """Sequence each string with upstream ``sequence()``. One Node call per batch."""
    if not texts:
        return []
    node = _require_node()
    try:
        proc = subprocess.run(
            [node, str(SCRIPT)],
            input=json.dumps(texts, ensure_ascii=False),
            capture_output=True,
            text=True,
            timeout=120,
            cwd=str(REPO_ROOT),
        )
    except subprocess.TimeoutExpired as exc:
        raise HebrewSequencingError(f"Node sequencing timed out: {exc}") from exc
    if proc.returncode != 0:
        raise HebrewSequencingError(f"Node sequencing failed: {proc.stderr.strip()}")
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        raise HebrewSequencingError(f"Node sequencing returned invalid JSON: {exc}") from exc
    if not isinstance(out, list) or len(out) != len(texts):
        raise HebrewSequencingError("Node sequencing returned an unexpected result shape.")
    return [str(t) for t in out]


def sequence_text(text: str) -> str:
    return sequence_texts([text])[0]

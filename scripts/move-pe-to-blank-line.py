#!/usr/bin/env python3
"""Move a pe that ends a line onto the blank line that follows it.

When a pe milestone is the last element of a line and the next line is
blank, the open paragraph on the page is that blank line, so the milestone
belongs after the blank line's <lb>. The blank line can be line 1 of the
next column. Only pe moves, never samekh. See issue #1111.

The edition files hold one element per line, so the script moves lines of
text and leaves the rest of each file as is. It does not touch the
revisionDesc; use the update-revisiondesc skill for that.

Usage:
    python3 scripts/move-pe-to-blank-line.py --dry-run
    python3 scripts/move-pe-to-blank-line.py
    python3 scripts/move-pe-to-blank-line.py 267B 291B
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EDITION = ROOT / "edition"

TAG = re.compile(r"^\s*<(/?)([a-zA-Z]+)")
PE = 'unit="section" subtype="pe"'
FOLIO = re.compile(r"^\d{3}[AB]$")


def kind(line: str) -> str:
    m = TAG.match(line)
    if not m:
        return ""
    return m.group(1) + m.group(2)


def is_pe(line: str) -> bool:
    return kind(line) == "milestone" and PE in line


def fix(lines: list[str]) -> tuple[list[str], list[str]]:
    """Return the new lines and the xml:id of each moved pe."""
    moved: list[str] = []
    i = 0
    while i < len(lines):
        if not is_pe(lines[i]):
            i += 1
            continue
        # the pe must follow text on its line, not sit on a blank line
        prev = i - 1
        while prev >= 0 and kind(lines[prev]) == "milestone":
            prev -= 1
        if prev < 0 or kind(lines[prev]) not in ("w", "pc"):
            i += 1
            continue
        # the pe must be the last element of its line
        j = i + 1
        if j >= len(lines) or kind(lines[j]) not in ("lb", "cb"):
            i += 1
            continue
        # find the <lb> that opens the next line
        k = j
        if kind(lines[k]) == "cb":
            k += 1
        if k >= len(lines) or kind(lines[k]) != "lb":
            i += 1
            continue
        # the next line must be blank
        if k + 1 >= len(lines) or kind(lines[k + 1]) not in ("lb", "cb", "/ab"):
            i += 1
            continue
        pe = lines.pop(i)
        lines.insert(k, pe)  # k shifts down by one after the pop
        m = re.search(r'xml:id="([^"]+)"', pe)
        moved.append(m.group(1) if m else pe.strip())
        i = k + 1
    return lines, moved


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("folios", nargs="*", help="folio sides (e.g. 267B); default all")
    ap.add_argument("-n", "--dry-run", action="store_true", help="report, do not write")
    args = ap.parse_args()

    if args.folios:
        bad = [f for f in args.folios if not FOLIO.match(f)]
        if bad:
            ap.error(f"not a folio side: {', '.join(bad)}")
        paths = [EDITION / f"{f}.xml" for f in args.folios]
    else:
        paths = sorted(p for p in EDITION.glob("*.xml") if FOLIO.match(p.stem))

    files = total = 0
    for path in paths:
        text = path.read_text(encoding="utf-8")
        lines, moved = fix(text.splitlines(keepends=True))
        if not moved:
            continue
        files += 1
        total += len(moved)
        print(f"{path.stem}: {', '.join(moved)}")
        if not args.dry_run:
            path.write_text("".join(lines), encoding="utf-8")

    verb = "would move" if args.dry_run else "moved"
    print(f"{verb} {total} pe marker(s) in {files} file(s)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

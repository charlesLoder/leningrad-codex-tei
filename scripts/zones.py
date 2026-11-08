#!/usr/bin/env python3
"""Add verse zones from the Masoretica HTR to committed edition files.

Zones are hand edits, not a pipeline stage: `generate-tei` does not keep
them. Run this script on the folios you work on, then commit the result.

Usage:
    uv run python scripts/zones.py download --folio 001B
    uv run python scripts/zones.py add --folio 001B --dry-run
    uv run python scripts/zones.py add --folio 001B

Omit --folio to run on all edition folios.

Masoretica (Idan Dershowitz) publishes handwritten text recognition (HTR)
results for the Leningrad Codex, one JSON file per page at
``https://www.masoretica.org/htr/leningrad/n{N}.json``. Its ``verses`` map
``"Book|chapter|verse"`` to ``{"c": confidence, "z": [[x, y, w, h], ...]}``:
one rect per line the verse touches on the page, in percent (0-100) of
the Archive.org image of the page. The page id ``n{N}`` is also the
Archive.org BookReader leaf, so folio ``NNN{A|B}`` is page ``2*NNN-2``
(+1 for side B).

``download`` pins the page JSON and the Archive.org IIIF ``info.json``
(image size only, no image download) under ``data/zones/`` (not committed),
byte for byte as served.

``add`` checks the zones against the folio's columns and lines, then
patches the committed TEI file in place (no re-serialization, so hand
edits and layout stay): the surface gets the Archive.org image size and
a second ``<graphic>`` (the Sefaria graphic stays first), one ``<zone>``
per verse holding one child ``<zone>`` per line segment, ``facs`` on each
verse milestone, a ``respStmt`` for Masoretica, and a ``<change>``.

TEI ``<zone>`` uses upper-left / lower-right (``ulx, uly, lrx, lry``) in
Archive.org image pixels; the site's IIIF build converts to ``x, y, w, h``.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import re
import statistics
import sys
import time
import urllib.error
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from xml.sax.saxutils import escape, quoteattr

from lxml import etree

from leningrad_codex_tei.stages.tei import contributor_xml_id
from leningrad_codex_tei.util.git import contributor_info
from leningrad_codex_tei.util.net import fetch_url

ROOT = Path(__file__).resolve().parent.parent
EDITION = ROOT / "edition"
ZONES = ROOT / "data" / "zones"

TEI_NS = "http://www.tei-c.org/ns/1.0"

ZONE_BASE_URL = "https://www.masoretica.org/htr/leningrad/"

ARCHIVE_IIIF_IMAGE_BASE = (
    "https://iiif.archive.org/image/iiif/3/Leningrad_Codex_Color_Images"
    "%2FLeningrad_Codex_Color_jp2.zip"
    "%2FLeningrad_Codex_Color_jp2"
    "%2FLeningrad_Codex_Color_"
)

RESP_ID = "source-masoretica"
RESP_STMT = (
    f'<respStmt xml:id="{RESP_ID}">\n'
    "  <resp>Verse zones from the Masoretica handwritten text recognition (HTR)"
    f' of the Leningrad Codex <ptr target="{ZONE_BASE_URL}"/></resp>\n'
    "  <persName>Idan Dershowitz</persName>\n"
    "</respStmt>\n"
)

FOLIO_RE = re.compile(r"^(\d{3})([AB])$")
SURFACE_RE = re.compile(
    r"^([ \t]*)<surface\b([^>]*)>(.*?)^[ \t]*</surface>", re.MULTILINE | re.DOTALL
)
GRAPHIC_RE = re.compile(
    r"^[ \t]*<graphic\b[^>]*?(?:/>|>.*?</graphic>)[ \t]*\n", re.MULTILINE | re.DOTALL
)
VERSE_MILESTONE_RE = re.compile(r'<milestone\b[^>]*\bunit="verse"[^>]*/>')
RESP_STMT_RE = re.compile(
    r"^([ \t]*)<respStmt\b.*?</respStmt>[ \t]*\n", re.MULTILINE | re.DOTALL
)
REVISION_OPEN_RE = re.compile(r"^([ \t]*)<revisionDesc>[ \t]*\n", re.MULTILINE)
FIRST_CHANGE_RE = re.compile(r"^([ \t]*)<change\b", re.MULTILINE)


def folio_page(folio: str) -> int:
    """Masoretica page number (= Archive.org leaf) for a folio side."""
    m = FOLIO_RE.match(folio)
    if m is None:
        raise ValueError(f"not a folio side: {folio!r}")
    return 2 * int(m.group(1)) - 2 + (1 if m.group(2) == "B" else 0)


def page_url(page: int) -> str:
    return f"{ZONE_BASE_URL}n{page}.json"


def archive_service_id(leaf: int) -> str:
    """IIIF Image API service id for a BookReader leaf (zero-padded JP2)."""
    return f"{ARCHIVE_IIIF_IMAGE_BASE}{leaf:04d}.jp2"


def archive_full_image_url(leaf: int) -> str:
    return f"{archive_service_id(leaf)}/full/max/0/default.jpg"


def archive_info_url(leaf: int) -> str:
    return f"{archive_service_id(leaf)}/info.json"


def zones_path(zones_dir: Path, folio: str) -> Path:
    return zones_dir / f"{folio}.json"


def info_path(zones_dir: Path, folio: str) -> Path:
    return zones_dir / f"{folio}.info.json"


def edition_book(book: str) -> str:
    """Masoretica book name -> edition milestone book (``1 Kings`` -> ``Kings_1``)."""
    m = re.match(r"^(\d) (.+)$", book)
    if m:
        book = f"{m.group(2)} {m.group(1)}"
    return book.replace(" ", "_")


def verse_n(key: str) -> str:
    """``"1 Kings|21|10"`` -> ``"Kings_1-21-10"`` (the milestone ``@n``)."""
    book, ch, v = key.split("|")
    return f"{edition_book(book)}-{ch}-{v}"


FETCH_ATTEMPTS = 3
FETCH_WAIT = 5.0


def fetch_with_retry(
    fetch: Callable[[str], bytes],
    url: str,
    sleep: Callable[[float], None] = time.sleep,
) -> bytes:
    """Fetch ``url``; try again after a timeout or a 5xx answer.

    The first Archive.org ``info.json`` request for a leaf is slow: the
    server takes the JP2 out of a zip, and the request can time out (a
    504 or a read timeout). The server caches the leaf after that, so a
    second request is usually fast.
    """
    for attempt in range(1, FETCH_ATTEMPTS + 1):
        try:
            return fetch(url)
        except urllib.error.HTTPError as exc:
            if exc.code < 500 or attempt == FETCH_ATTEMPTS:
                raise
        except (TimeoutError, urllib.error.URLError):
            if attempt == FETCH_ATTEMPTS:
                raise
        sleep(FETCH_WAIT)
    raise AssertionError("unreachable")


def download_zones(
    zones_dir: Path,
    folio: str,
    fetch: Callable[[str], bytes] = fetch_url,
    sleep: Callable[[float], None] = time.sleep,
) -> dict | None:
    """Pin the zone JSON and Archive.org ``info.json`` for one folio side.

    Returns None when Masoretica has no page for the folio (HTTP 404).
    Raises ValueError when the page names another folio, or its image
    does not have the same shape as the Archive.org leaf (wrong leaf).
    """
    page = folio_page(folio)
    url = page_url(page)
    try:
        raw = fetch_with_retry(fetch, url, sleep)
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        raise
    doc = json.loads(raw)
    if doc.get("folio") != folio:
        raise ValueError(f"{url} is folio {doc.get('folio')!r}, not {folio!r}")

    info_url = archive_info_url(page)
    info_raw = fetch_with_retry(fetch, info_url, sleep)
    info = json.loads(info_raw)
    width, height = int(info["width"]), int(info["height"])
    report = doc.get("_meta", {}).get("report", {})
    size = report.get("imageSize")
    if size and abs(size[0] / size[1] - width / height) > 0.01:
        raise ValueError(
            f"zone image {size[0]}x{size[1]} does not match the shape of "
            f"Archive.org leaf {page} ({width}x{height})"
        )

    zones_dir.mkdir(parents=True, exist_ok=True)
    zones_path(zones_dir, folio).write_bytes(raw)
    info_path(zones_dir, folio).write_bytes(info_raw)
    return {
        "folio": folio,
        "page": f"n{page}",
        "url": url,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "info_url": info_url,
        "width": width,
        "height": height,
        "verses": len(doc.get("verses", {})),
        "page_confidence": report.get("pageConfidence"),
    }


@dataclass
class VerseZone:
    n: str
    cert: float | None
    # (ulx, uly, lrx, lry) in Archive.org image pixels, one per line segment
    rects: list[tuple[int, int, int, int]]


@dataclass
class ZoneSource:
    folio: str
    url: str
    sha256: str
    page: int
    width: int
    height: int
    verses: list[VerseZone]


def load_zones(zones_dir: Path, folio: str) -> ZoneSource:
    """Read the pinned zone JSON and convert percent rects to pixels."""
    raw = zones_path(zones_dir, folio).read_bytes()
    doc = json.loads(raw)
    info = json.loads(info_path(zones_dir, folio).read_text())
    width, height = int(info["width"]), int(info["height"])
    verses = []
    for key, entry in doc.get("verses", {}).items():
        rects = [percent_to_pixels(r, width, height) for r in entry.get("z", [])]
        verses.append(VerseZone(n=verse_n(key), cert=entry.get("c"), rects=rects))
    page = folio_page(folio)
    return ZoneSource(
        folio=folio,
        url=page_url(page),
        sha256=hashlib.sha256(raw).hexdigest(),
        page=page,
        width=width,
        height=height,
        verses=verses,
    )


def percent_to_pixels(
    rect: list[float], width: int, height: int
) -> tuple[int, int, int, int]:
    """``[x, y, w, h]`` in percent -> ``(ulx, uly, lrx, lry)`` in pixels."""
    x, y, w, h = rect
    return (
        round(x / 100 * width),
        round(y / 100 * height),
        round((x + w) / 100 * width),
        round((y + h) / 100 * height),
    )


def verse_lines(tei_text: str) -> dict[str, list[tuple[int, int]]]:
    """Verse ``@n`` -> distinct (column, line) pairs holding its words, in order.

    Single-column pages have no ``<cb>``; their lines are column 1.
    A ``<w>`` inside a ``<del>`` (an erased word) is not verse text.
    """
    root = etree.fromstring(tei_text.encode("utf-8"))
    body = root.find(f".//{{{TEI_NS}}}body")
    lines: dict[str, list[tuple[int, int]]] = {}
    col, line, verse = 1, 0, None
    for el in body.iter() if body is not None else ():
        if not isinstance(el.tag, str):
            continue
        tag = etree.QName(el).localname
        if tag == "cb":
            col = int(el.get("n"))
        elif tag == "lb":
            line = int(el.get("n"))
        elif tag == "milestone" and el.get("unit") == "verse":
            verse = el.get("n")
            lines.setdefault(verse, [])
        elif (
            tag == "w"
            and verse is not None
            and (col, line) not in lines[verse]
            and next(el.iterancestors(f"{{{TEI_NS}}}del"), None) is None
        ):
            lines[verse].append((col, line))
    return lines


def drop_margin_rects(verses: list[VerseZone]) -> tuple[list[VerseZone], int]:
    """Drop rects outside the page's text block; return (verses, dropped).

    The HTR also matches verse words that the masora magna quotes in the
    top and bottom margins; those rects are not the main biblical text.
    The text block runs from the 5th to the 95th percentile of rect
    edges, plus two line heights. Pages with fewer than 10 rects are
    kept as they are.
    """
    rects = [r for vz in verses for r in vz.rects]
    if len(rects) < 10:
        return verses, 0
    height = statistics.median(r[3] - r[1] for r in rects)
    k = len(rects) // 20
    top = sorted(r[1] for r in rects)[k] - 2 * height
    bottom = sorted(r[3] for r in rects)[-k - 1] + 2 * height
    kept = [
        replace(vz, rects=[r for r in vz.rects if top <= (r[1] + r[3]) / 2 <= bottom])
        for vz in verses
    ]
    return kept, len(rects) - sum(len(vz.rects) for vz in kept)


def check_verse(vz: VerseZone, spans: list[tuple[int, int]] | None) -> list[str]:
    """Check that a verse zone has a verse milestone to point to. Empty = pass.

    Masoretica data is trusted, so the number, order and columns of the
    rects are not compared with the edition's lines.
    """
    if not spans:
        return [f"{vz.n}: no verse milestone with words on this folio"]
    return []


def check_zones(
    source: ZoneSource, lines: dict[str, list[tuple[int, int]]]
) -> list[str]:
    """``check_verse`` for every verse zone. Empty list = pass."""
    return [p for vz in source.verses for p in check_verse(vz, lines.get(vz.n))]


def zone_id(folio: str, n: str) -> str:
    return f"f{folio}-zone-{n}"


def _zone_block(folio: str, vz: VerseZone, indent: str, child_indent: str) -> list[str]:
    zid = zone_id(folio, vz.n)
    cert = f' cert="{vz.cert}"' if vz.cert is not None else ""
    out = [f'{indent}<zone xml:id="{zid}" type="verse"{cert} resp="#{RESP_ID}">']
    for i, (ulx, uly, lrx, lry) in enumerate(vz.rects, start=1):
        out.append(
            f'{child_indent}<zone xml:id="{zid}-s{i}" ulx="{ulx}" uly="{uly}"'
            f' lrx="{lrx}" lry="{lry}"/>'
        )
    out.append(f"{indent}</zone>")
    return out


def _patch_surface(text: str, source: ZoneSource, order: list[str]) -> str:
    m = SURFACE_RE.search(text)
    if m is None:
        raise ValueError("no <surface> found")
    indent, attrs, inner = m.group(1), m.group(2), m.group(3)
    sid = re.search(r'xml:id="([^"]*)"', attrs)
    sid_attr = f' xml:id="{sid.group(1)}"' if sid else ""
    child = indent + "  "
    archive_id = f"f{source.folio}-img-archive"
    kept = "".join(
        g.group(0) for g in GRAPHIC_RE.finditer(inner) if archive_id not in g.group(0)
    )
    rank = {n: i for i, n in enumerate(order)}
    verses = sorted(source.verses, key=lambda vz: rank.get(vz.n, len(rank)))
    lines = [
        (
            f'{child}<graphic xml:id="{archive_id}"'
            f' url="{archive_full_image_url(source.page)}"'
            f' width="{source.width}px" height="{source.height}px"/>'
        )
    ]
    for vz in verses:
        lines.extend(_zone_block(source.folio, vz, child, child + "  "))
    surface = (
        f'{indent}<surface{sid_attr} ulx="0" uly="0" lrx="{source.width}"'
        f' lry="{source.height}">\n{kept}' + "\n".join(lines) + f"\n{indent}</surface>"
    )
    return text[: m.start()] + surface + text[m.end() :]


def _patch_milestones(text: str, source: ZoneSource) -> str:
    zoned = {vz.n for vz in source.verses}

    def repl(m: re.Match) -> str:
        tag = re.sub(r'\s+facs="[^"]*"', "", m.group(0))
        n = re.search(r'\bn="([^"]*)"', tag)
        if n is None or n.group(1) not in zoned:
            return tag
        facs = f' facs="#{zone_id(source.folio, n.group(1))}"'
        return tag[:-2].rstrip() + facs + "/>"

    return VERSE_MILESTONE_RE.sub(repl, text)


def _add_resp_stmt(text: str, block: str, after_sources: bool = False) -> str:
    """Insert ``block`` after the last respStmt (or the last ``source-*`` one)."""
    stmts = list(RESP_STMT_RE.finditer(text))
    if not stmts:
        raise ValueError("no respStmt found")
    sources = [s for s in stmts if 'xml:id="source-' in s.group(0)]
    last = (sources if after_sources and sources else stmts)[-1]
    indented = "".join(last.group(1) + ln + "\n" for ln in block.splitlines())
    return text[: last.end()] + indented + text[last.end() :]


def _add_change(text: str, when: str, who: str, desc: str, url: str) -> str:
    opener = REVISION_OPEN_RE.search(text)
    if opener is None:
        raise ValueError("no <revisionDesc> found")
    first = FIRST_CHANGE_RE.search(text, opener.end())
    indent = first.group(1) if first else opener.group(1) + "  "
    block = (
        f'{indent}<change when="{when}" who="{who}">{escape(desc)}\n'
        f'{indent}  <ptr type="zones" target="{url}"/>\n'
        f"{indent}</change>\n"
    )
    return text[: opener.end()] + block + text[opener.end() :]


def _plural(n: int, word: str) -> str:
    return word if n == 1 else word + "s"


@dataclass
class ZoneResult:
    folio: str
    problems: list[str] = field(default_factory=list)
    changed: bool = False
    # verse zones in the source, and those that passed (and are written)
    verses: int = 0
    written: int = 0
    segments: int = 0
    # margin rects left out (see drop_margin_rects)
    dropped: int = 0
    edition_verses: int = 0

    @property
    def passed(self) -> bool:
        return not self.problems


def apply_zones(
    tei_path: Path,
    source: ZoneSource,
    *,
    when: str,
    contributor: dict | None = None,
    write: bool = True,
) -> ZoneResult:
    """Check zones against a committed TEI file, then patch it in place.

    Margin rects are dropped first. Only verses that pass ``check_verse``
    get a zone; the others are listed in ``problems``. Nothing is written
    when no verse passes, or when the zones already in the file are the
    same (so a re-run adds no new ``<change>``).
    ``contributor`` is ``{name, email, xml_id}``; without one the change
    is credited to the pipeline.
    """
    text = tei_path.read_text(encoding="utf-8")
    lines = verse_lines(text)
    verses, dropped = drop_margin_rects(source.verses)
    passing: list[VerseZone] = []
    problems: list[str] = []
    for vz in verses:
        found = check_verse(vz, lines.get(vz.n))
        problems.extend(found)
        if not found:
            passing.append(vz)
    result = ZoneResult(
        folio=source.folio,
        problems=problems,
        verses=len(verses),
        written=len(passing),
        segments=sum(len(vz.rects) for vz in passing),
        dropped=dropped,
        edition_verses=len(lines),
    )
    if not passing:
        return result

    source = replace(source, verses=passing)
    patched = _patch_milestones(_patch_surface(text, source, list(lines)), source)
    if patched == text:
        return result

    if f'xml:id="{RESP_ID}"' not in patched:
        patched = _add_resp_stmt(patched, RESP_STMT, after_sources=True)
    who = "#leningrad-codex-tei"
    if contributor:
        who = f"#{contributor['xml_id']}"
        if f'xml:id="{contributor["xml_id"]}"' not in patched:
            ref = (
                f" ref={quoteattr('mailto:' + contributor['email'])}"
                if contributor.get("email")
                else ""
            )
            patched = _add_resp_stmt(
                patched,
                f'<respStmt xml:id="{contributor["xml_id"]}">\n'
                "  <resp>TEI encoding</resp>\n"
                f"  <persName{ref}>{escape(contributor['name'])}</persName>\n"
                "</respStmt>\n",
            )
    # Describe what changed: only zones that were not in the file already.
    had = set(re.findall(r'xml:id="([^"]*-zone-[^"]*)"', text))
    new = [vz for vz in passing if zone_id(source.folio, vz.n) not in had]
    if had and new:
        count, segs = len(new), sum(len(vz.rects) for vz in new)
        desc = (
            f"Added {count} missing verse {_plural(count, 'zone')}"
            f" ({segs} line {_plural(segs, 'segment')})"
            f" from Masoretica HTR page n{source.page}."
        )
    elif had:
        desc = f"Updated verse zones from Masoretica HTR page n{source.page}."
    else:
        desc = (
            f"Added {result.written} verse {_plural(result.written, 'zone')}"
            f" ({result.segments} line {_plural(result.segments, 'segment')})"
            f" from Masoretica HTR page n{source.page}."
        )
    if result.problems:
        failed = result.verses - result.written
        desc += (
            f" Left out {failed} verse {_plural(failed, 'zone')}"
            " that have no verse milestone on the folio."
        )
    patched = _add_change(patched, when, who, desc, source.url)
    etree.fromstring(patched.encode("utf-8"))
    result.changed = True
    if write:
        tei_path.write_text(patched, encoding="utf-8")
    return result


def edition_folios() -> list[str]:
    return sorted(p.stem for p in EDITION.glob("*.xml") if p.stem != "index")


def cmd_download(folio: str | None) -> int:
    for page in [folio] if folio else edition_folios():
        try:
            info = download_zones(ZONES, page)
        except (ValueError, OSError) as exc:
            print(f"download: {page} error: {exc}", file=sys.stderr)
            continue
        if info is None:
            print(f"download: {page} no Masoretica page")
            continue
        print(
            f"download: {page} <- {info['url']} "
            f"({info['verses']} verses, image {info['width']}x{info['height']})"
        )
    return 0


def _contributor() -> dict | None:
    try:
        info = contributor_info(ROOT)
    except OSError:
        return None
    if not info:
        return None
    return {**info, "xml_id": contributor_xml_id(info.get("name"), info.get("email"))}


def cmd_add(folio: str | None, dry_run: bool) -> int:
    if folio is not None:
        if not zones_path(ZONES, folio).exists():
            print(
                f"no zones for {folio} (run: download --folio {folio})",
                file=sys.stderr,
            )
            return 1
        folios = [folio]
    else:
        folios = [f for f in edition_folios() if zones_path(ZONES, f).exists()]
    contributor = _contributor()
    when = dt.datetime.now(dt.UTC).date().isoformat()
    written = failed = 0
    for page in folios:
        result = apply_zones(
            EDITION / f"{page}.xml",
            load_zones(ZONES, page),
            when=when,
            contributor=contributor,
            write=not dry_run,
        )
        written += result.written
        failed += result.verses - result.written
        summary = (
            f"{result.written}/{result.verses} zones, "
            f"{result.edition_verses} edition verses, "
            f"{result.segments} segments, {result.dropped} margin rects dropped"
        )
        if result.changed:
            verb = "would add" if dry_run else "added"
            print(f"add: {page} {verb} zones ({summary})")
        else:
            print(f"add: {page} unchanged ({summary})")
        for problem in result.problems:
            print(f"  left out {problem}", file=sys.stderr)
    print(f"add: {written} verse zones passed, {failed} left out")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Add Masoretica verse zones.")
    commands = parser.add_subparsers(dest="command", required=True)
    download = commands.add_parser("download", help="Pin zone data for folios.")
    download.add_argument("--folio", help="One folio (e.g. 001B). Omit for all.")
    add = commands.add_parser("add", help="Add pinned zones to edition files.")
    add.add_argument("--folio", help="One folio (e.g. 001B). Omit for all.")
    add.add_argument(
        "--dry-run", action="store_true", help="Run the checks; write nothing."
    )
    args = parser.parse_args(argv)
    if args.command == "download":
        return cmd_download(args.folio)
    return cmd_add(args.folio, args.dry_run)


if __name__ == "__main__":
    sys.exit(main())

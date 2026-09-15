"""build-word-stream stage: parse UXLC XML files into a flat word stream.

Atom semantics (verified against the lci seed):
every main-text word counts as exactly one atom. Main-text words are the
``<w>`` and ``<k>`` (ketiv) elements inside a verse; qere ``<q>`` elements
and transcription-note ``<x>`` elements do not count. Atoms are numbered
globally, 1-based, across the whole codex in canonical book order.
"""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path

from lxml import etree

from leningrad_codex_tei.schemas import UxlcEdition, Word, WordStream

CANONICAL_BOOK_ORDER = [
    "Genesis",
    "Exodus",
    "Leviticus",
    "Numbers",
    "Deuteronomy",
    "Joshua",
    "Judges",
    "Samuel_1",
    "Samuel_2",
    "Kings_1",
    "Kings_2",
    "Isaiah",
    "Jeremiah",
    "Ezekiel",
    "Hosea",
    "Joel",
    "Amos",
    "Obadiah",
    "Jonah",
    "Micah",
    "Nahum",
    "Habakkuk",
    "Zephaniah",
    "Haggai",
    "Zechariah",
    "Malachi",
    "Psalms",
    "Proverbs",
    "Job",
    "Song_of_Songs",
    "Ruth",
    "Lamentations",
    "Ecclesiastes",
    "Esther",
    "Daniel",
    "Ezra",
    "Nehemiah",
    "Chronicles_1",
    "Chronicles_2",
]


def _edition_from_root(root: etree._Element) -> UxlcEdition | None:
    """Version identity from a UXLC ``editionStmt/edition``, or None when absent."""
    for el in root.iter():
        if _local_name(el) != "editionStmt":
            continue
        for child in el:
            if _local_name(child) != "edition":
                continue
            fields: dict[str, str] = {}
            for sub in child:
                tag = _local_name(sub)
                if tag == "buildDateTime":
                    tag = "build_datetime"
                if tag in ("version", "date", "build", "build_datetime"):
                    text = (sub.text or "").strip()
                    if text:
                        fields[tag] = text
            return UxlcEdition(**fields) if fields else None
    return None


def read_uxlc_edition(
    uxlc_dir: Path, book_order: list[str] | None = None
) -> UxlcEdition | None:
    """Read the UXLC edition identity from the first available book XML."""
    files = _ordered_book_files(uxlc_dir, book_order)
    if not files:
        return None
    try:
        root = etree.fromstring(files[0].read_bytes())
    except (OSError, etree.LxmlError):
        return None
    return _edition_from_root(root)


def build_word_stream(uxlc_dir: Path, book_order: list[str] | None = None) -> WordStream:
    """Parse every book XML in ``uxlc_dir`` into a global word stream."""
    files = _ordered_book_files(uxlc_dir, book_order)

    words: list[Word] = []
    atom = 0
    edition: UxlcEdition | None = None
    for path in files:
        root = etree.fromstring(path.read_bytes())
        if edition is None:
            edition = _edition_from_root(root)
        book = path.stem
        for chapter_el in root.iter():
            if _local_name(chapter_el) != "c":
                continue
            chapter_str = chapter_el.get("n")
            if chapter_str is None:
                continue
            chapter = int(chapter_str)
            for verse_el in chapter_el:
                if _local_name(verse_el) != "v":
                    continue
                verse_str = verse_el.get("n")
                if verse_str is None:
                    continue
                verse = int(verse_str)
                has_pe = any(_local_name(c) == "pe" for c in verse_el)
                has_samekh = any(_local_name(c) == "samekh" for c in verse_el)
                in_verse = 0
                for child in verse_el:
                    tag = _local_name(child)
                    if tag not in ("w", "k"):
                        continue
                    in_verse += 1
                    atom += 1
                    words.append(
                        Word(
                            atom=atom,
                            text=_element_text(child),
                            book=book,
                            chapter=chapter,
                            verse=verse,
                            word_index=in_verse,
                            has_pe=has_pe,
                            has_samekh=has_samekh,
                        )
                    )

    return WordStream(
        source=str(uxlc_dir),
        generated_at=datetime.now(timezone.utc),
        words=words,
        uxlc_edition=edition,
    )


def dump_word_stream(stream: WordStream) -> dict:
    """Contract JSON: source, generated_at iso, uxlc_edition, words (asdict each)."""
    return {
        "source": stream.source,
        "generated_at": stream.generated_at.isoformat(),
        "uxlc_edition": asdict(stream.uxlc_edition) if stream.uxlc_edition else None,
        "words": [asdict(w) for w in stream.words],
    }


def save_word_stream(stream: WordStream, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(dump_word_stream(stream), indent=2))


def load_word_stream(path: Path) -> WordStream:
    data = json.loads(path.read_text())
    edition = data.get("uxlc_edition")
    return WordStream(
        source=data["source"],
        generated_at=datetime.fromisoformat(data["generated_at"]),
        words=[Word(**w) for w in data["words"]],
        uxlc_edition=UxlcEdition(**edition) if edition else None,
    )


def _ordered_book_files(uxlc_dir: Path, book_order: list[str] | None) -> list[Path]:
    if book_order is not None:
        return [uxlc_dir / f"{name}.xml" for name in book_order if (uxlc_dir / f"{name}.xml").exists()]
    rank = {name: i for i, name in enumerate(CANONICAL_BOOK_ORDER)}
    files = [p for p in uxlc_dir.glob("*.xml")]
    files.sort(key=lambda p: (rank.get(p.stem, len(rank)), p.name))
    return files


def _local_name(el: etree._Element) -> str:
    return (el.tag.rsplit("}", 1)[-1]) if isinstance(el.tag, str) else ""


def _element_text(el: etree._Element) -> str:
    """Text of a word element, dropping ``<x>`` transcription-note content."""
    parts = [el.text or ""]
    for child in el:
        if _local_name(child) == "x":
            parts.append(child.tail or "")
        else:
            parts.append(child.text or "")
            parts.append(child.tail or "")
    return "".join(parts)
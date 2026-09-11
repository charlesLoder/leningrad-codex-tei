"""Whole-codex word-stream contract, locked against a mock source set (ticket 02).

Locks in the ticket-02 accept criteria at the ``build_word_stream(repo_xml)``
seam, over a trimmed slice of the real source set (``tests/fixtures/uxlc-whole/``,
extracted from the configured ``data/uxlc`` Genesis book, chapters 1-3): the
stream covers every book in the source set, atom numbering is continuous and
matches the UXLC main-text convention, every word carries a resolvable biblical
reference, the Genesis 1 slice matches the pilot's stream, and paragraph markers
surface across the book.
"""

from __future__ import annotations

from pathlib import Path

from leningrad_codex_tei.stages.word_stream import (
    CANONICAL_BOOK_ORDER,
    build_word_stream,
)

REPO_XML = Path(__file__).parent / "fixtures" / "uxlc-whole"


def _source_stream():
    return build_word_stream(REPO_XML)


def test_covers_every_book_in_the_source_set() -> None:
    ws = _source_stream()
    source_books = sorted(p.stem for p in REPO_XML.glob("*.xml"))
    # every book XML in the source set contributes words; no book is dropped
    assert source_books
    stream_books = sorted({w.book for w in ws.words})
    assert stream_books == source_books
    # every source book must have a canonical slot
    for book in stream_books:
        assert book in CANONICAL_BOOK_ORDER, f"{book} not in canonical order"


def test_atom_numbering_is_continuous_and_whole() -> None:
    ws = _source_stream()
    atoms = [w.atom for w in ws.words]
    # 1-based, gapless, spanning exactly the number of atoms
    assert atoms == list(range(1, len(ws.words) + 1))


def test_every_word_carries_a_resolvable_reference() -> None:
    ws = _source_stream()
    assert ws.words
    unresolved = [
        w
        for w in ws.words
        if not (w.book in CANONICAL_BOOK_ORDER and w.chapter >= 1 and w.verse >= 1 and w.word_index >= 1)
    ]
    assert unresolved == []
    # Genesis 1 opens the stream and its words are contiguous from atom 1
    gen1 = [w for w in ws.words if w.chapter == 1]
    assert gen1 and gen1[0].atom == 1 and gen1[-1].verse == 31


def test_genesis_1_slice_matches_the_pilot_stream() -> None:
    ws = _source_stream()
    gen1 = [w for w in ws.words if w.chapter == 1]
    # pilot stream known-good head: pointed text (ketiv + vocalisation) as the pilot kept
    assert [(w.atom, w.word_index, w.text) for w in gen1[:3]] == [
        (1, 1, "בְּרֵאשִׁ֖ית"),
        (2, 2, "בָּרָ֣א"),
        (3, 3, "אֱלֹהִ֑ים"),
    ]
    # the F001B folio is seeded to Gen 1:1 – 1:26 and resolves to atoms 1..326:
    # atom 326 must be word 9 of verse 26 (the seed's stop part for 001B)
    v26 = [w for w in gen1 if w.verse == 26]
    assert v26
    assert v26[8].atom == 326


def test_samekh_and_pe_flags_surface_across_the_book() -> None:
    ws = _source_stream()
    pe = [w for w in ws.words if w.has_pe]
    samekh = [w for w in ws.words if w.has_samekh]
    # paragraph markers exist in the real text and are carried per-word,
    # mutually exclusive within any single verse
    assert pe and samekh
    assert all(not (w.has_pe and w.has_samekh) for w in ws.words)
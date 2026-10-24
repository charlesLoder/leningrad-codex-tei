"""Tests for the build-word-stream stage: UXLC XML -> flat word stream."""

from __future__ import annotations

from pathlib import Path

import pytest

from leningrad_codex_tei.stages.word_stream import (
    build_word_stream,
    load_word_stream,
    read_uxlc_edition,
    save_word_stream,
)


def words_by_verse(ws) -> dict[tuple[int, int], list[tuple[int, str]]]:
    grouped: dict[tuple[int, int], list[tuple[int, str]]] = {}
    for w in ws.words:
        grouped.setdefault((w.chapter, w.verse), []).append((w.word_index, w.text))
    return grouped


def test_atoms_are_global_and_sequential(uxlc_fixture_dir: Path) -> None:
    ws = build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])
    assert [w.atom for w in ws.words] == list(range(1, 11))
    assert len(ws.words) == 10


def test_verse_shapes(uxlc_fixture_dir: Path) -> None:
    ws = build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])
    grouped = words_by_verse(ws)

    assert grouped[(1, 1)] == [
        (1, "בְּרֵאשִׁ֖ית"),
        (2, "בָּרָ֣א"),
        (3, "אֱלֹהִ֑ים"),
    ]
    # <x> note markup is stripped from the word text
    assert grouped[(1, 2)] == [
        (1, "וְהָאָ֗רֶץ"),
        (2, "בְּעֵ֖דֶן"),
    ]
    assert grouped[(1, 3)] == [(1, "אֽוֹר׃")]
    assert grouped[(2, 1)] == [(1, "אֶחָד"), (2, "י֔וֹם")]
    # ketiv <k> counts as an atom; qere <q> does not
    assert grouped[(2, 2)] == [(1, "כֶּתֶב"), (2, "דָּבָר")]


def test_keeps_vocalization(uxlc_fixture_dir: Path) -> None:
    ws = build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])
    assert ws.words[0].text == "בְּרֵאשִׁ֖ית"


def test_section_marker_sits_on_the_atom_it_follows(uxlc_fixture_dir: Path) -> None:
    ws = build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])
    marked = [(w.atom, w.section) for w in ws.words if w.section is not None]
    # Gen 1:3 ends with <pe/>; Gen 2:1 has <samekh/> mid-verse, after its first word
    assert marked == [(6, "pe"), (7, "samekh")]


def test_inverted_nun_sits_on_the_atom_it_follows(uxlc_fixture_dir: Path) -> None:
    ws = build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])
    assert [w.atom for w in ws.words if w.inverted_nun] == [6]
    # the mark is not part of the atom text
    assert ws.words[5].text == "אֽוֹר׃"


def test_metadata_fields(uxlc_fixture_dir: Path) -> None:
    ws = build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])
    first = ws.words[0]
    assert first.book == "Genesis"
    assert first.chapter == 1
    assert first.verse == 1
    assert first.word_index == 1
    assert ws.source == str(uxlc_fixture_dir)


def test_empty_directory_yields_empty_stream(tmp_path: Path) -> None:
    ws = build_word_stream(tmp_path, book_order=["Genesis"])
    assert ws.words == []


def test_uxlc_edition_parsed_from_editionStmt(uxlc_fixture_dir: Path) -> None:
    ws = build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])
    assert ws.uxlc_edition is not None
    assert ws.uxlc_edition.version == "UXLC 9.9-test"
    assert ws.uxlc_edition.date == "1 Jan 2026"
    assert ws.uxlc_edition.build == "0.1-test"
    assert ws.uxlc_edition.build_datetime == "31 Dec 2025 12:00"


def test_read_uxlc_edition_returns_none_without_metadata(tmp_path: Path) -> None:
    assert read_uxlc_edition(tmp_path) is None
    d = tmp_path / "uxlc"
    d.mkdir()
    (d / "Genesis.xml").write_text(
        "<Tanach><teiHeader><fileDesc><editionStmt>"
        "<edition>Bare edition, no version children</edition>"
        "</editionStmt></fileDesc></teiHeader>"
        "<tanach><book><c n='1'><v n='1'><w>x</w></v></c></book></tanach></Tanach>",
        encoding="utf-8",
    )
    assert read_uxlc_edition(d) is None


def test_word_stream_edition_roundtrips_through_json(
    uxlc_fixture_dir: Path, tmp_path: Path
) -> None:
    ws = build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])
    dest = tmp_path / "word_stream.json"
    save_word_stream(ws, dest)
    assert load_word_stream(dest).uxlc_edition == ws.uxlc_edition


def test_note_x_verse_is_flagged_not_in_codex(tmp_path: Path) -> None:
    # Josh 21:36-37 carry UXLC note X: in the stream for numbering, not on the page
    d = tmp_path / "uxlc"
    d.mkdir()
    (d / "Joshua.xml").write_text(
        "<Tanach><tanach><book><c n='21'>"
        "<v n='35'><w>a</w><w>b</w></v>"
        "<v n='36'><x>X</x><w>c</w><w>d</w></v>"
        "<v n='37'><x>X</x><w>e</w><samekh/></v>"
        "<v n='38'><w>f<x>4</x></w></v>"
        "</c></book></tanach></Tanach>",
        encoding="utf-8",
    )
    ws = build_word_stream(d, book_order=["Joshua"])
    assert [w.atom for w in ws.words] == [1, 2, 3, 4, 5, 6]
    assert [w.not_in_codex for w in ws.words] == [
        False,
        False,
        True,
        True,
        True,
        False,
    ]

    dest = tmp_path / "word_stream.json"
    save_word_stream(ws, dest)
    assert [w.not_in_codex for w in load_word_stream(dest).words] == [
        w.not_in_codex for w in ws.words
    ]

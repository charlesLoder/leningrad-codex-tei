"""Tests for the build-index stage."""

from __future__ import annotations

from pathlib import Path

from lxml import etree

from leningrad_codex_tei.stages.index import build_index

TEI = "http://www.tei-c.org/ns/1.0"


def _tei(folio: str, verse_range: str) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        f'<TEI xmlns="{TEI}">'
        f"<teiHeader><fileDesc><titleStmt><title>{verse_range}</title></titleStmt></fileDesc></teiHeader>"
        f'<text><body><pb n="{folio}"/></body></text>'
        "</TEI>"
    )


def test_build_index_lists_each_folio(tmp_path: Path) -> None:
    out = tmp_path / "out"
    out.mkdir()
    (out / "001B.xml").write_text(_tei("001B", "Genesis 1:1 – 2:2"))
    (out / "002A.xml").write_text(_tei("002A", "Genesis 1:26 – 2:19"))

    index_xml = build_index(out)
    root = etree.fromstring(index_xml.encode())

    assert root.tag.split("}", 1)[-1] == "index"
    entries = root.findall("entry")
    assert len(entries) == 2
    assert [(e.get("folio"), e.get("href")) for e in entries] == [
        ("001B", "001B.xml"),
        ("002A", "002A.xml"),
    ]
    titles = [e.findtext("title") for e in entries]
    assert titles == ["Genesis 1:1 – 2:2", "Genesis 1:26 – 2:19"]


def test_build_index_empty_dir(tmp_path: Path) -> None:
    out = tmp_path / "empty"
    out.mkdir()
    index_xml = build_index(out)
    root = etree.fromstring(index_xml.encode())
    assert root.findall("entry") == []
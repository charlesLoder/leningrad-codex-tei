"""Tests for scripts/zones.py (Masoretica verse zones)."""

from __future__ import annotations

import dataclasses
import importlib.util
import json
import sys
import urllib.error
from pathlib import Path

import pytest
from lxml import etree

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "zones.py"
_spec = importlib.util.spec_from_file_location("zones_script", SCRIPT)
zones_stage = importlib.util.module_from_spec(_spec)
sys.modules["zones_script"] = zones_stage
_spec.loader.exec_module(zones_stage)

TEI = """<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Leningrad Codex — 001B</title>
        <respStmt xml:id="leningrad-codex-tei">
          <resp>created by</resp>
          <name>leningrad-codex-tei</name>
        </respStmt>
        <respStmt xml:id="source-seed">
          <resp>Folio mapping</resp>
          <persName>Ben Denckla</persName>
        </respStmt>
        <respStmt xml:id="contrib-jane-doe">
          <resp>TEI encoding and alignment</resp>
          <persName>Jane Doe</persName>
        </respStmt>
      </titleStmt>
    </fileDesc>
    <revisionDesc>
      <change when="2026-10-20" who="#contrib-jane-doe">
      Hand edit.
      </change>
    </revisionDesc>
  </teiHeader>
  <facsimile>
    <surface xml:id="surf-001B">
      <graphic xml:id="f001B-img-sefaria" url="https://example.test/sefaria.jpg">
        <desc type="sha256">abc</desc>
      </graphic>
    </surface>
  </facsimile>

  <text>
    <body>
      <div type="edition">
        <ab>
        <cb xml:id="f001B-cb-1" n="1"/>
          <lb xml:id="f001B-lb-1-1" n="1"/>
            <milestone unit="verse" n="Genesis-1-1" xml:id="f001B-v-Genesis-1-1"/>
            <w xml:id="f001B-w-1">a</w>
          <lb xml:id="f001B-lb-1-2" n="2"/>
            <w xml:id="f001B-w-2">b</w>
            <milestone unit="verse" n="Genesis-1-2" xml:id="f001B-v-Genesis-1-2"/>
            <w xml:id="f001B-w-3">c</w>
        <cb xml:id="f001B-cb-2" n="2"/>
          <lb xml:id="f001B-lb-2-1" n="1"/>
            <w xml:id="f001B-w-4">d</w>
        </ab>
      </div>
    </body>
  </text>
</TEI>
"""

# Column 1 is on the right (x 60-80%), column 2 on the left (x 20-40%).
ZONES = {
    "folio": "001B",
    "_meta": {"report": {"imageSize": [1000, 2000]}},
    "verses": {
        "Genesis|1|2": {"c": 0.9, "z": [[60, 12, 10, 2], [20, 10, 20, 2]]},
        "Genesis|1|1": {"c": 0.99, "z": [[60, 10, 20, 2], [70, 12, 10, 2]]},
    },
}
INFO = {"width": 2000, "height": 4000}


@pytest.fixture
def zones_dir(tmp_path):
    d = tmp_path / "zones"
    d.mkdir()
    (d / "001B.json").write_text(json.dumps(ZONES))
    (d / "001B.info.json").write_text(json.dumps(INFO))
    return d


@pytest.fixture
def tei_path(tmp_path):
    p = tmp_path / "001B.xml"
    p.write_text(TEI)
    return p


def test_folio_page_maps_sides_to_pages():
    assert zones_stage.folio_page("001B") == 1
    assert zones_stage.folio_page("002A") == 2
    assert zones_stage.folio_page("002B") == 3
    assert zones_stage.folio_page("251A") == 500
    with pytest.raises(ValueError):
        zones_stage.folio_page("1B")


def test_verse_n_uses_edition_book_names():
    assert zones_stage.verse_n("Genesis|1|3") == "Genesis-1-3"
    assert zones_stage.verse_n("1 Kings|21|10") == "Kings_1-21-10"
    assert zones_stage.verse_n("Song of Songs|1|1") == "Song_of_Songs-1-1"


def test_percent_to_pixels_converts_to_corners():
    assert zones_stage.percent_to_pixels([10, 20, 30, 5], 1000, 2000) == (
        100,
        400,
        400,
        500,
    )


def test_download_zones_pins_both_files(tmp_path):
    served = {
        zones_stage.page_url(1): json.dumps(ZONES).encode(),
        zones_stage.archive_info_url(1): json.dumps(INFO).encode(),
    }
    info = zones_stage.download_zones(tmp_path, "001B", fetch=served.__getitem__)
    assert info["page"] == "n1"
    assert (info["width"], info["height"]) == (2000, 4000)
    assert (tmp_path / "001B.json").read_bytes() == served[zones_stage.page_url(1)]
    assert (tmp_path / "001B.info.json").exists()


def test_download_zones_returns_none_on_404(tmp_path):
    calls = []

    def fetch(url):
        calls.append(url)
        raise urllib.error.HTTPError(url, 404, "not found", None, None)

    assert zones_stage.download_zones(tmp_path, "001A", fetch=fetch) is None
    assert len(calls) == 1


def test_download_zones_retries_timeouts_and_5xx(tmp_path):
    served = {
        zones_stage.page_url(1): json.dumps(ZONES).encode(),
        zones_stage.archive_info_url(1): json.dumps(INFO).encode(),
    }
    failures = [
        TimeoutError("The read operation timed out"),
        urllib.error.HTTPError("info", 504, "gateway timeout", None, None),
    ]
    waits = []

    def fetch(url):
        if url == zones_stage.archive_info_url(1) and failures:
            raise failures.pop(0)
        return served[url]

    info = zones_stage.download_zones(tmp_path, "001B", fetch=fetch, sleep=waits.append)
    assert info["width"] == 2000
    assert waits == [zones_stage.FETCH_WAIT] * 2


def test_download_zones_stops_after_last_attempt(tmp_path):
    calls = []

    def fetch(url):
        calls.append(url)
        raise TimeoutError("The read operation timed out")

    with pytest.raises(TimeoutError):
        zones_stage.download_zones(tmp_path, "001B", fetch=fetch, sleep=lambda _: None)
    assert len(calls) == zones_stage.FETCH_ATTEMPTS


def test_download_zones_rejects_other_folio_and_wrong_shape(tmp_path):
    other = {**ZONES, "folio": "002A"}
    served = {
        zones_stage.page_url(1): json.dumps(other).encode(),
        zones_stage.archive_info_url(1): json.dumps(INFO).encode(),
    }
    with pytest.raises(ValueError, match="002A"):
        zones_stage.download_zones(tmp_path, "001B", fetch=served.__getitem__)
    served[zones_stage.page_url(1)] = json.dumps(ZONES).encode()
    served[zones_stage.archive_info_url(1)] = json.dumps(
        {"width": 4000, "height": 4000}
    ).encode()
    with pytest.raises(ValueError, match="shape"):
        zones_stage.download_zones(tmp_path, "001B", fetch=served.__getitem__)


def test_verse_lines_tracks_columns_and_lines():
    assert zones_stage.verse_lines(TEI) == {
        "Genesis-1-1": [(1, 1), (1, 2)],
        "Genesis-1-2": [(1, 2), (2, 1)],
    }


def test_check_zones_passes_matching_layout(zones_dir):
    source = zones_stage.load_zones(zones_dir, "001B")
    assert zones_stage.check_zones(source, zones_stage.verse_lines(TEI)) == []


def test_check_zones_only_reports_missing_milestone(zones_dir):
    source = zones_stage.load_zones(zones_dir, "001B")
    v1, v2 = sorted(source.verses, key=lambda v: v.n)
    v1.rects = v1.rects[:1]
    v2.rects = list(reversed(v2.rects))
    source.verses.append(zones_stage.VerseZone(n="Genesis-1-3", cert=1, rects=[]))
    problems = zones_stage.check_zones(source, zones_stage.verse_lines(TEI))
    assert problems == ["Genesis-1-3: no verse milestone with words on this folio"]


def test_apply_zones_patches_in_place(zones_dir, tei_path):
    source = zones_stage.load_zones(zones_dir, "001B")
    contributor = {"name": "Jane Doe", "email": None, "xml_id": "contrib-jane-doe"}
    result = zones_stage.apply_zones(
        tei_path, source, when="2026-10-22", contributor=contributor
    )
    assert result.passed and result.changed
    text = tei_path.read_text()

    # Sefaria graphic kept first, byte for byte; archive graphic added.
    assert '<surface xml:id="surf-001B" ulx="0" uly="0" lrx="2000" lry="4000">' in text
    assert text.index("f001B-img-sefaria") < text.index("f001B-img-archive")
    assert '        <desc type="sha256">abc</desc>\n' in text
    assert 'width="2000px" height="4000px"/>' in text

    # Zones in edition order, with segments in Archive.org pixels.
    assert text.index('xml:id="f001B-zone-Genesis-1-1"') < text.index(
        'xml:id="f001B-zone-Genesis-1-2"'
    )
    assert (
        '<zone xml:id="f001B-zone-Genesis-1-1" type="verse" cert="0.99"'
        ' resp="#source-masoretica">'
    ) in text
    assert (
        '<zone xml:id="f001B-zone-Genesis-1-1-s1" ulx="1200" uly="400"'
        ' lrx="1600" lry="480"/>'
    ) in text

    # Milestones point at their zones; the rest of the body is untouched.
    assert (
        '<milestone unit="verse" n="Genesis-1-1" xml:id="f001B-v-Genesis-1-1"'
        ' facs="#f001B-zone-Genesis-1-1"/>'
    ) in text
    assert text[text.index("<text>") :].count("facs=") == 2

    # Masoretica credited after the source respStmts; change at the top.
    assert text.index('xml:id="source-seed"') < text.index('xml:id="source-masoretica"')
    assert text.index('xml:id="source-masoretica"') < text.index(
        'xml:id="contrib-jane-doe"'
    )
    assert "<persName>Idan Dershowitz</persName>" in text
    assert text.index("Added 2 verse zones (4 line segments)") < text.index(
        "Hand edit."
    )
    assert text.count('xml:id="contrib-jane-doe"') == 1
    etree.fromstring(text.encode())


def test_apply_zones_rerun_is_a_no_op(zones_dir, tei_path):
    source = zones_stage.load_zones(zones_dir, "001B")
    zones_stage.apply_zones(tei_path, source, when="2026-10-22")
    first = tei_path.read_text()
    result = zones_stage.apply_zones(tei_path, source, when="2026-10-23")
    assert result.passed and not result.changed
    assert tei_path.read_text() == first
    assert first.count('source-masoretica"') == 1 + 2  # respStmt + 2 zone @resp


def test_apply_zones_rerun_with_new_data_replaces_zones(zones_dir, tei_path):
    zones_stage.apply_zones(
        tei_path, zones_stage.load_zones(zones_dir, "001B"), when="2026-10-22"
    )
    data = json.loads((zones_dir / "001B.json").read_text())
    data["verses"]["Genesis|1|1"]["c"] = 0.5
    (zones_dir / "001B.json").write_text(json.dumps(data))
    result = zones_stage.apply_zones(
        tei_path, zones_stage.load_zones(zones_dir, "001B"), when="2026-10-23"
    )
    text = tei_path.read_text()
    assert result.changed
    assert text.count('type="verse" cert=') == 2
    assert 'cert="0.5"' in text and 'cert="0.99"' not in text
    assert text.count("f001B-img-archive") == 1
    assert text.count('type="zones"') == 2
    assert text.count('xml:id="source-masoretica"') == 1


def test_apply_zones_keeps_verses_with_different_rect_count(zones_dir, tei_path):
    source = zones_stage.load_zones(zones_dir, "001B")
    bad = next(vz for vz in source.verses if vz.n == "Genesis-1-2")
    bad.rects = bad.rects[:1]
    result = zones_stage.apply_zones(tei_path, source, when="2026-10-22")
    assert result.problems == []
    assert (result.verses, result.written, result.changed) == (2, 2, True)
    assert 'xml:id="f001B-zone-Genesis-1-2"' in tei_path.read_text()


def test_apply_zones_leaves_out_verse_without_milestone(zones_dir, tei_path):
    source = zones_stage.load_zones(zones_dir, "001B")
    source.verses.append(
        zones_stage.VerseZone(n="Genesis-1-3", cert=1, rects=[(1, 1, 2, 2)])
    )
    result = zones_stage.apply_zones(tei_path, source, when="2026-10-22")
    assert result.problems == [
        "Genesis-1-3: no verse milestone with words on this folio"
    ]
    text = tei_path.read_text()
    assert "f001B-zone-Genesis-1-3" not in text
    assert "Left out 1 verse zone that have no verse milestone on the folio." in text


def test_drop_margin_rects_removes_masora_matches():
    # 40 text lines from y=1000 to y=2950, 50 px apart, 40 px high.
    verses = [
        zones_stage.VerseZone(
            n=f"Genesis-1-{i}", cert=0.9, rects=[(100, y, 500, y + 40)]
        )
        for i, y in enumerate(range(1000, 3000, 50), start=1)
    ]
    verses[0].rects.insert(0, (200, 20, 600, 60))  # top margin
    verses[-1].rects.append((200, 3900, 600, 3940))  # bottom margin
    kept, dropped = zones_stage.drop_margin_rects(verses)
    assert dropped == 2
    assert [len(vz.rects) for vz in kept] == [1] * 40
    assert verses[0].rects[0] == (200, 20, 600, 60)  # input not changed


def test_add_command_patches_edition_file(zones_dir, tei_path, monkeypatch, capsys):
    monkeypatch.setattr(zones_stage, "EDITION", tei_path.parent)
    monkeypatch.setattr(zones_stage, "ZONES", zones_dir)
    monkeypatch.setattr(zones_stage, "contributor_info", lambda _: None)

    before = tei_path.read_text()
    assert zones_stage.main(["add", "--folio", "001B", "--dry-run"]) == 0
    assert tei_path.read_text() == before
    assert "would add zones" in capsys.readouterr().out

    assert zones_stage.main(["add"]) == 0
    assert "f001B-img-archive" in tei_path.read_text()
    assert "add: 001B added zones" in capsys.readouterr().out


def test_add_command_fails_without_downloaded_zones(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(zones_stage, "ZONES", tmp_path)
    assert zones_stage.main(["add", "--folio", "002A"]) == 1
    assert "no zones for 002A" in capsys.readouterr().err


def test_apply_zones_change_counts_only_missing_zones(zones_dir, tei_path):
    source = zones_stage.load_zones(zones_dir, "001B")
    first = zones_stage.VerseZone(**{**source.verses[0].__dict__})
    zones_stage.apply_zones(
        tei_path, dataclasses.replace(source, verses=[first]), when="2026-10-22"
    )
    zones_stage.apply_zones(tei_path, source, when="2026-10-23")
    text = tei_path.read_text()
    assert "Added 1 verse zone (2 line segments)" in text
    assert "Added 1 missing verse zone (2 line segments)" in text

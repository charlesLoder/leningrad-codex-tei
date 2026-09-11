"""Tests for the generate-tei stage: template rendering + provenance header."""

from __future__ import annotations

from datetime import datetime

import pytest
from lxml import etree

from leningrad_codex_tei.schemas import PipelineRun, RunStage
from leningrad_codex_tei.stages.align import build_alignment_record
from leningrad_codex_tei.stages.tei import (
    changes_from_audit,
    render_folio_tei,
    repo_snapshot_url,
    source_image_from_audit,
)

TEI = "http://www.tei-c.org/ns/1.0"
XML = "http://www.w3.org/XML/1998/namespace"


def _id(el: etree._Element) -> str | None:
    return el.get(f"{{{XML}}}id")


def _q(tag: str) -> str:
    return f"{{{TEI}}}{tag}"


# Stub layout for the 10-atom fixture: 3 words/line, wrap on verse boundary,
# then the resulting lines are spread evenly across 3 columns.
_TEI_PLACEMENTS = [
    (1, 1, 1), (2, 1, 1), (3, 1, 1),
    (4, 1, 2), (5, 1, 2),
    (6, 2, 1),
    (7, 2, 2), (8, 2, 2),
    (9, 3, 1), (10, 3, 1),
]


@pytest.fixture
def alignment(seed_slice, word_stream):
    slice_words = word_stream.words[seed_slice.atom_start - 1 : seed_slice.atom_end]
    return build_alignment_record(seed_slice, slice_words, _TEI_PLACEMENTS)


@pytest.fixture
def changes() -> list[dict]:
    return [
        {
            "when": "2026-08-27T00:00:01",
            "text": "Aligned Genesis 1:1 – 2:2 (10 atoms, stub).",
            "features": [
                {"name": "stage", "value": "align-folio"},
                {"name": "model", "value": "test-model"},
            ],
        },
    ]


def test_rendered_xml_is_well_formed_and_structured(alignment, changes) -> None:
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="0.1.0-dev",
    )
    root = etree.fromstring(xml.encode())
    assert root.tag == _q("TEI")

    pbs = root.findall(f".//{_q('pb')}")
    assert len(pbs) == 1
    assert _id(pbs[0]) == "f001B-pb-001B"
    assert pbs[0].get("n") == "001B"

    assert len(root.findall(f".//{_q('cb')}")) == 3

    ab = root.find(f".//{_q('div')}[@type='edition']/{_q('ab')}")
    assert ab is not None

    words = root.findall(f".//{_q('w')}")
    assert [_id(w) for w in words] == [f"f001B-w-{i}" for i in range(1, 11)]
    assert {etree.QName(w.getparent()).localname for w in words} == {"ab"}
    # generate-tei emits SBL-sequenced Hebrew; only words whose marks
    # arrive out of order differ from the raw fixture text.
    assert [w.text for w in words] == [
        "בְּרֵאשִׁ֖ית",
        "בָּרָ֣א",
        "אֱלֹהִ֑ים",
        "וְהָאָ֗רֶץ",
        "בְּעֵ֖דֶן",
        "\u05d0\u05bd\u05b9\u05d5\u05e8\u05c3",  # sequenced: holam precedes vav
        "אֶחָד",
        "\u05d9\u0594\u05b9\u05d5\u05dd",  # sequenced: holam precedes vav
        "כֶּתֶב",
        "דָּבָר",
    ]

    changes = root.findall(f".//{_q('revisionDesc')}/{_q('change')}")
    assert len(changes) == 1
    assert changes[0].get("when") == "2026-08-27T00:00:01"
    assert changes[0].get("who") == "#leningrad-codex-tei"
    assert "Aligned Genesis 1:1" in (changes[0].text or "")
    fs = changes[0].find(_q("fs"))
    assert fs is not None
    assert fs.get("type") == "ai-params"


def test_ids_are_folio_prefixed_and_unique(alignment, changes) -> None:
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="0.1.0-dev",
    )
    root = etree.fromstring(xml.encode())
    ids = [_id(el) for el in root.iter() if _id(el) is not None]
    assert "leningrad-codex-tei" in ids
    assert "surf-001B" in ids
    body_ids = [
        i for i in ids if i not in ("leningrad-codex-tei", "surf-001B")
    ]
    assert body_ids
    assert all(i.startswith("f001B-") for i in body_ids)
    assert len(set(body_ids)) == len(body_ids)


def test_verse_and_section_milestones(alignment, changes) -> None:
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="0.1.0-dev",
    )
    root = etree.fromstring(xml.encode())

    verse_ms = root.findall(f".//{_q('milestone')}[@unit='verse']")
    assert [(m.get("n"), m.get("id"), _id(m)) for m in verse_ms] == [
        ("Genesis-1-1", None, "f001B-v-Genesis-1-1"),
        ("Genesis-1-2", None, "f001B-v-Genesis-1-2"),
        ("Genesis-1-3", None, "f001B-v-Genesis-1-3"),
        ("Genesis-2-1", None, "f001B-v-Genesis-2-1"),
        ("Genesis-2-2", None, "f001B-v-Genesis-2-2"),
    ]

    section_ms = root.findall(f".//{_q('milestone')}[@unit='section']")
    assert [(m.get("subtype"), _id(m)) for m in section_ms] == [
        ("pe", "f001B-s-Genesis-1-3"),
        ("samekh", "f001B-s-Genesis-2-1"),
    ]

    # document order: the verse milestone precedes its verse's first word,
    # the section milestone follows the verse's last word
    seen: list[str] = []
    for el in root.iter():
        tag = etree.QName(el).localname
        if tag == "w":
            seen.append(_id(el) or "")
        elif tag == "milestone":
            seen.append(f"{el.get('unit')}:{el.get('n') or el.get('subtype')}")
    assert seen == [
        "verse:Genesis-1-1",
        "f001B-w-1",
        "f001B-w-2",
        "f001B-w-3",
        "verse:Genesis-1-2",
        "f001B-w-4",
        "f001B-w-5",
        "verse:Genesis-1-3",
        "f001B-w-6",
        "section:pe",
        "verse:Genesis-2-1",
        "f001B-w-7",
        "f001B-w-8",
        "section:samekh",
        "verse:Genesis-2-2",
        "f001B-w-9",
        "f001B-w-10",
    ]


def test_application_element_carries_pipeline_version(alignment, changes) -> None:
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="9.9.9",
        generated_when="2026-08-27T00:00:03",
    )
    root = etree.fromstring(xml.encode())
    apps = root.findall(f".//{_q('application')}")
    assert len(apps) == 1
    app = apps[0]
    assert app.get("ident") == "leningrad-codex-tei"
    assert app.get("version") == "9.9.9"
    assert app.get("when") == "2026-08-27T00:00:03"
    assert app.find(_q("ab")) is None
    assert app.find(_q("fs")) is None


def test_repo_ptr_points_at_snapshot(alignment, changes) -> None:
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="9.9.9",
        repo_hash="37961352d8841b661861f5fbd1eeb0a34bdab142-dirty",
    )
    root = etree.fromstring(xml.encode())
    ptr = root.find(f".//{_q('application')}/{_q('ptr')}")
    assert ptr.get("target") == (
        "https://github.com/charlesLoder/leningrad-codex-tei"
        "/commit/37961352d8841b661861f5fbd1eeb0a34bdab142"
    )
    assert repo_snapshot_url("unknown") is None


def test_changes_from_audit_keeps_only_align_folio() -> None:
    runs = [
        PipelineRun(
            stage=RunStage.DOWNLOAD_IMAGES,
            input_image_sha256="deadbeef",
            timestamp=datetime(2026, 8, 27, 1, 2, 3),
        ),
        PipelineRun(
            stage=RunStage.ALIGN_FOLIO,
            model="gpt-4o",
            prompt_version="prose-v1",
            result_summary={
                "method": "ai-vision",
                "atoms": 412,
                "range": "Genesis 1:1 – 2:2",
            },
            timestamp=datetime(2026, 8, 27, 1, 2, 4),
        ),
        PipelineRun(
            stage=RunStage.VALIDATE,
            result_summary={"passed": True},
            timestamp=datetime(2026, 8, 27, 1, 2, 5),
        ),
        PipelineRun(
            stage=RunStage.GENERATE_TEI,
            result_summary={"folio": "001B"},
            timestamp=datetime(2026, 8, 27, 1, 2, 6),
        ),
    ]
    changes = changes_from_audit(runs)
    assert len(changes) == 1
    assert changes[0]["when"] == "2026-08-27T01:02:04"
    assert changes[0]["text"] == "Aligned Genesis 1:1 – 2:2 (412 atoms, ai-vision)."
    feats = {f["name"]: f["value"] for f in changes[0]["features"]}
    assert feats["model"] == "gpt-4o"
    assert feats["prompt_version"] == "prose-v1"


def test_changes_are_most_recent_first() -> None:
    runs = [
        PipelineRun(
            stage=RunStage.ALIGN_FOLIO,
            result_summary={"method": "stub", "atoms": 10, "range": "Genesis 1:1"},
            timestamp=datetime(2026, 8, 27, 1, 2, 3),
        ),
        PipelineRun(
            stage=RunStage.ALIGN_FOLIO,
            result_summary={"method": "stub", "atoms": 12, "range": "Genesis 1:1"},
            timestamp=datetime(2026, 8, 27, 1, 2, 4),
        ),
    ]
    changes = changes_from_audit(runs)
    assert [c["when"] for c in changes] == [
        "2026-08-27T01:02:04",
        "2026-08-27T01:02:03",
    ]


def test_changes_carry_no_features_without_model() -> None:
    runs = [
        PipelineRun(
            stage=RunStage.ALIGN_FOLIO,
            result_summary={"method": "stub", "atoms": 10, "range": "Genesis 1:1"},
            timestamp=datetime(2026, 8, 27, 1, 2, 5),
        ),
    ]
    changes = changes_from_audit(runs)
    assert changes[0]["features"] == []
    assert changes_from_audit([]) == []


def test_changes_carry_thinking_level() -> None:
    runs = [
        PipelineRun(
            stage=RunStage.ALIGN_FOLIO,
            model="gemini-3.8-flash",
            temperature=1.0,
            result_summary={"ai": {"thinking_level": "high"}},
            timestamp=datetime(2026, 8, 27, 1, 2, 4),
        ),
    ]
    changes = changes_from_audit(runs)
    feats = {f["name"]: f["value"] for f in changes[0]["features"]}
    assert feats["thinking_level"] == "high"


def test_change_text_falls_back_without_summary() -> None:
    runs = [
        PipelineRun(
            stage=RunStage.ALIGN_FOLIO,
            timestamp=datetime(2026, 8, 27, 1, 2, 5),
        ),
    ]
    assert changes_from_audit(runs)[0]["text"] == "Aligned folio."


def test_ai_params_render_as_fs_inside_change(alignment) -> None:
    changes = changes_from_audit(
        [
            PipelineRun(
                stage=RunStage.ALIGN_FOLIO,
                model="gemini-3.8-flash",
                temperature=1.0,
                prompt_version="align-v3",
                result_summary={
                    "method": "ai-vision",
                    "atoms": 10,
                    "range": "Genesis 1:1 – 2:2",
                    "ai": {"inference": "batch"},
                },
                timestamp=datetime(2026, 8, 27, 1, 2, 4),
            ),
        ]
    )
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="9.9.9",
    )
    root = etree.fromstring(xml.encode())
    fs = root.find(f".//{_q('revisionDesc')}/{_q('change')}/{_q('fs')}")
    assert fs is not None
    assert fs.get("type") == "ai-params"
    feats = {f.get("name"): f.find(_q("string")).text for f in fs.findall(_q("f"))}
    assert feats == {
        "stage": "align-folio",
        "model": "gemini-3.8-flash",
        "temperature": "1.0",
        "prompt_version": "align-v3",
        "inference": "batch",
    }


def test_source_image_from_audit_prefers_latest() -> None:
    runs = [
        PipelineRun(
            stage=RunStage.DOWNLOAD_IMAGES,
            input_image_sha256="old",
            result_summary={"url": "https://example.org/old.jpg", "sha256": "old"},
            timestamp=datetime(2026, 8, 27, 1, 2, 5),
        ),
        PipelineRun(
            stage=RunStage.DOWNLOAD_IMAGES,
            input_image_sha256="new",
            result_summary={"url": "https://example.org/new.jpg", "sha256": "new"},
            timestamp=datetime(2026, 8, 27, 1, 2, 6),
        ),
    ]
    assert source_image_from_audit(runs) == {
        "url": "https://example.org/new.jpg",
        "sha256": "new",
    }
    assert source_image_from_audit([]) is None


def test_source_image_renders_graphic_in_facsimile(
    alignment, changes
) -> None:
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="9.9.9",
        source_image={"url": "https://example.org/001B.jpg", "sha256": "abc123"},
    )
    root = etree.fromstring(xml.encode())
    surface = root.find(f".//{_q('facsimile')}/{_q('surface')}")
    assert surface is not None
    assert _id(surface) == "surf-001B"
    graphic = surface.find(_q("graphic"))
    assert graphic is not None
    assert graphic.get("url") == "https://example.org/001B.jpg"
    ms_desc = root.find(f".//{_q('sourceDesc')}/{_q('msDesc')}")
    assert ms_desc is not None
    assert root.find(f".//{_q('sourceDesc')}/{_q('p')}") is None


def test_facsimile_omits_graphic_without_image(
    alignment, changes
) -> None:
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="9.9.9",
    )
    root = etree.fromstring(xml.encode())
    surface = root.find(f".//{_q('facsimile')}/{_q('surface')}")
    assert surface is not None
    assert _id(surface) == "surf-001B"
    assert surface.find(_q("graphic")) is None
    ms_desc = root.find(f".//{_q('sourceDesc')}/{_q('msDesc')}")
    assert ms_desc is not None


def test_publication_stmt_has_mit_availability(
    alignment, changes
) -> None:
    xml = render_folio_tei(
        folio="001B",
        verse_range="Genesis 1:1 – 2:2",
        record=alignment,
        page_milestones=[{"folio": "001B"}],
        changes=changes,
        pipeline_version="9.9.9",
    )
    root = etree.fromstring(xml.encode())
    availability = root.find(f".//{_q('publicationStmt')}/{_q('availability')}")
    assert availability is not None
    assert availability.get("status") == "free"
    assert availability.find(_q("licence")).text == "MIT License"
    ptr = availability.find(f"{_q('p')}/{_q('ptr')}")
    assert ptr.get("target") == "https://github.com/charlesLoder/leningrad-codex-tei"
    pub = root.find(f".//{_q('publicationStmt')}")
    assert pub is not None
    assert pub.find(_q("authority")).text == "leningrad-codex-tei"
    assert pub.find(_q("p")) is None
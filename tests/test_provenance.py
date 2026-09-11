"""Tests for the per-folio audit trail and pipeline provenance modules."""

from __future__ import annotations

from datetime import datetime

from leningrad_codex_tei.provenance import (
    append_run,
    audit_path,
    load_audit,
    load_pipeline_provenance,
    save_pipeline_provenance,
    update_pipeline_provenance,
)
from leningrad_codex_tei.schemas import (
    FolioStatus,
    IndexProvenance,
    PipelineProvenance,
    PipelineRun,
    RunStage,
    SeedProvenance,
    UxlcProvenance,
    WordStreamProvenance,
)


def _run(stage: RunStage, **kw) -> PipelineRun:
    return PipelineRun(
        stage=stage,
        timestamp=datetime(2026, 8, 27, 1, 2, 3),
        result_summary={"records": 10},
        **kw,
    )


def test_load_audit_missing_returns_none(tmp_path) -> None:
    assert load_audit(tmp_path, "001B") is None


def test_append_run_creates_trail(tmp_path) -> None:
    run = _run(RunStage.DOWNLOAD_IMAGES, input_image_sha256="deadbeef")
    trail = append_run(tmp_path, "001B", run)

    assert audit_path(tmp_path, "001B").exists()
    assert trail.folio == "001B"
    assert trail.status == FolioStatus.PENDING
    assert trail.runs == [run]


def test_append_run_accumulates_in_order(tmp_path) -> None:
    for stage in (RunStage.DOWNLOAD_IMAGES, RunStage.ALIGN_FOLIO, RunStage.GENERATE_TEI):
        append_run(tmp_path, "001B", _run(stage))

    trail = load_audit(tmp_path, "001B")
    assert trail is not None
    assert [r.stage for r in trail.runs] == [
        RunStage.DOWNLOAD_IMAGES,
        RunStage.ALIGN_FOLIO,
        RunStage.GENERATE_TEI,
    ]


def test_append_run_bumps_updated_at(tmp_path) -> None:
    trail1 = append_run(tmp_path, "001B", _run(RunStage.DOWNLOAD_IMAGES))
    trail2 = append_run(tmp_path, "001B", _run(RunStage.GENERATE_TEI))
    assert trail2.updated_at >= trail1.created_at
    assert trail2.updated_at >= trail2.created_at


def test_append_run_sets_status(tmp_path) -> None:
    append_run(
        tmp_path,
        "001B",
        _run(RunStage.VALIDATE),
        status=FolioStatus.ALIGNED,
    )
    trail = load_audit(tmp_path, "001B")
    assert trail is not None
    assert trail.status == FolioStatus.ALIGNED


def test_roundtrip_preserves_run_metadata(tmp_path) -> None:
    run = _run(
        RunStage.ALIGN_FOLIO,
        model="gpt-4o",
        prompt_version="prose-v1",
        input_image_sha256="deadbeef",
        checks={"words": 10, "ok": True},
    )
    append_run(tmp_path, "001B", run)
    trail = load_audit(tmp_path, "001B")
    assert trail is not None
    loaded = trail.runs[0]
    assert loaded.model == "gpt-4o"
    assert loaded.prompt_version == "prose-v1"
    assert loaded.input_image_sha256 == "deadbeef"
    assert loaded.checks == {"words": 10, "ok": True}
    assert loaded.result_summary == {"records": 10}


def test_load_provenance_missing_returns_blank(tmp_path) -> None:
    prov = load_pipeline_provenance(tmp_path / "provenance.json")
    assert prov.project_version is None
    assert prov.seed is None
    assert prov.uxlc is None
    assert prov.word_stream is None
    assert prov.index is None


def test_provenance_roundtrip_preserves_sections(tmp_path) -> None:
    prov = PipelineProvenance(
        project_version="0.1.0-dev",
        seed=SeedProvenance(
            url="https://example.invalid/seed.json",
            commit="main",
            snapshot_commit="deadbee",
            sha256="s" * 64,
            records=1,
            path=str(tmp_path / "seed.json"),
        ),
        uxlc=UxlcProvenance(
            url="https://example.invalid/tanach.zip",
            path=str(tmp_path / "uxlc"),
            files=46,
            zip_sha256="z" * 64,
        ),
        word_stream=WordStreamProvenance(
            source=str(tmp_path / "uxlc"),
            sha256="w" * 64,
            words=20613,
            path=str(tmp_path / "word_stream.json"),
        ),
        index=IndexProvenance(path=str(tmp_path / "index.xml"), entries=1),
    )
    path = tmp_path / "provenance.json"
    save_pipeline_provenance(path, prov)
    loaded = load_pipeline_provenance(path)
    assert loaded.project_version == "0.1.0-dev"
    assert loaded.seed == prov.seed
    assert loaded.uxlc == prov.uxlc
    assert loaded.word_stream == prov.word_stream
    assert loaded.index == prov.index
    assert loaded.updated_at >= prov.updated_at


def test_update_sets_one_section_and_keeps_others(tmp_path) -> None:
    path = tmp_path / "provenance.json"
    seed = SeedProvenance(
        url="https://example.invalid/seed.json",
        commit="main",
        snapshot_commit="deadbee",
        sha256="s" * 64,
        records=1,
        path=str(tmp_path / "seed.json"),
    )
    update_pipeline_provenance(path, "0.1.0-dev", seed=seed)
    update_pipeline_provenance(path, "0.1.0-dev", index=IndexProvenance(path="index.xml", entries=1))

    loaded = load_pipeline_provenance(path)
    assert loaded.seed == seed
    assert loaded.index == IndexProvenance(path="index.xml", entries=1)
    assert loaded.uxlc is None
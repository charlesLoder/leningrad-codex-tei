"""End-to-end test: all eight CLI stages against a hermetic tmp pipeline."""

from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from unittest.mock import patch

import yaml
from click.testing import CliRunner
from lxml import etree

from leningrad_epidoc.cli import cli
from leningrad_epidoc.config import Config
from leningrad_epidoc.schemas import WordStream
from leningrad_epidoc.stages import align as align_stage
from leningrad_epidoc.stages.align import SeedSlice
from leningrad_epidoc.util import net

FIXTURES = Path(__file__).parent / "fixtures"
JPEG_BYTES = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"


def _uxlc_zip_bytes() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        archive.writestr(
            "Genesis.xml", (FIXTURES / "uxlc" / "Genesis.xml").read_bytes()
        )
    return buf.getvalue()


def _write_config(tmp_path: Path) -> Path:
    uxlc = tmp_path / "uxlc"
    uxlc.mkdir(parents=True)

    conf = tmp_path / "config.yaml"
    conf.write_text(
        yaml.safe_dump(
            {
                "project": {"name": "leningrad-epidoc", "version": "0.1.0-dev"},
                "paths": {
                    "uxlc": str(uxlc),
                    "seed": str(tmp_path / "seed" / "lci_recs.json"),
                    "images": str(tmp_path / "images"),
                    "output": str(tmp_path / "out"),
                    "audit": str(tmp_path / "audit"),
                    "alignments": str(tmp_path / "alignments"),
                    "word_stream": str(tmp_path / "word_stream.json"),
                    "provenance": str(tmp_path / "provenance.json"),
                },
                "images": {
                    "base_url": "https://example.invalid/",
                    "naming": "BIB_LENCDX_F{folio}.jpg",
                },
                "seed": {
                    "upstream_url": "https://github.com/bdenckla/codex-index-leningrad",
                    "commit": "main",
                    "snapshot_commit": "deadbee",
                    "file": "UXLC-utils-sparse/data/lci_recs.json",
                },
                "uxlc": {
                    "download_url": "https://example.invalid/Books/Tanach.xml.zip"
                },
                "ai": {"model": "test-model", "max_retries": 1},
            }
        )
    )
    return conf


def _placements_to_xml(
    placements: list[tuple[int, int, int]], stream: WordStream
) -> str:
    by_line: dict[tuple[int, int], list[str]] = {}
    order: list[tuple[int, int]] = []
    for atom, col, line in placements:
        key = (col, line)
        if key not in by_line:
            by_line[key] = []
            order.append(key)
        by_line[key].append(stream.words[atom - 1].text)

    parts: list[str] = []
    cur_col = None
    for col, line in order:
        if col != cur_col:
            parts.append(f'<cb n="{col}" />')
            cur_col = col
        parts.append(f'<lb n="{line}" />')
        parts.append(" ".join(by_line[(col, line)]))
    return "\n".join(parts)


def _run_pipeline(runner: CliRunner, conf: Path) -> None:
    def fake(url: str) -> bytes:
        assert url.startswith("https://"), url
        if "lci_recs.json" in url:
            return (FIXTURES / "seed" / "lci_recs.json").read_bytes()
        if "Tanach.xml.zip" in url:
            return _uxlc_zip_bytes()
        return JPEG_BYTES

    def fake_align(
        sl: SeedSlice, stream: WordStream, config: Config, prompt: str
    ) -> str:
        # Stub-like layout: line per verse boundary, 3 columns, document order
        placements = [
            (1, 1, 1),
            (2, 1, 1),
            (3, 1, 1),
            (4, 1, 2),
            (5, 1, 2),
            (6, 2, 1),
            (7, 2, 2),
            (8, 2, 2),
            (9, 3, 1),
            (10, 3, 1),
        ]
        return _placements_to_xml(placements, stream)

    net.fetch_url = fake
    commands = [
        ["--config", str(conf), "vendor-seed"],
        ["--config", str(conf), "download-uxlc"],
        ["--config", str(conf), "download-images", "--folio", "001B"],
        ["--config", str(conf), "build-word-stream"],
        ["--config", str(conf), "align-folio", "--folio", "001B"],
        ["--config", str(conf), "validate", "--folio", "001B"],
        ["--config", str(conf), "generate-tei", "--folio", "001B"],
        ["--config", str(conf), "build-index"],
    ]
    align_patch = patch.object(
        align_stage,
        "_request_alignment",
        side_effect=fake_align,
    )
    clean_patch = patch.object(align_stage, "ensure_align_prompt_clean", lambda: None)
    align_patch.start()
    clean_patch.start()
    try:
        for args in commands:
            result = runner.invoke(cli, args)
            assert result.exit_code == 0, f"{args}\n{result.output}\n{result.exception}"
            assert result.exception is None
    finally:
        align_patch.stop()
        clean_patch.stop()


def test_pipeline_runs_end_to_end(tmp_path: Path) -> None:
    conf = _write_config(tmp_path)
    _run_pipeline(CliRunner(), conf)

    # contract artifacts exist
    assert (tmp_path / "seed" / "lci_recs.json").exists()
    assert (tmp_path / "images" / "BIB_LENCDX_F001B.jpg").read_bytes() == JPEG_BYTES
    word_stream = json.loads((tmp_path / "word_stream.json").read_text())
    assert (tmp_path / "alignments" / "001B.json").exists()
    alignment_json = json.loads((tmp_path / "alignments" / "001B.json").read_text())
    assert "<cb" in alignment_json["model_response"]
    assert alignment_json["section_milestones"]
    raw_path = tmp_path / "alignments" / "raw" / "001B.xml"
    assert raw_path.exists()
    assert raw_path.read_text() == alignment_json["model_response"]

    conv_path = tmp_path / "alignments" / "conversations" / "001B.json"
    assert conv_path.exists()
    conv = json.loads(conv_path.read_text())
    assert conv["folio"] == "001B"
    assert conv["model"] == "test-model"
    assert conv["response"] == alignment_json["model_response"]
    assert [m["role"] for m in conv["messages"]] == ["user", "model"]
    assert (tmp_path / "uxlc" / "Genesis.xml").exists()
    assert not list((tmp_path / "uxlc").glob("*.zip"))
    assert word_stream["words"][0]["atom"] == 1

    # audit trail: one run per per-folio stage, in pipeline order, status moved out of pending.
    # global corpus stages (vendor-seed, download-uxlc, build-word-stream, build-index)
    # are recorded once in provenance.json, not inside every folio's trail.
    audit = json.loads((tmp_path / "audit" / "001B.json").read_text())
    assert [r["stage"] for r in audit["runs"]] == [
        "download-images",
        "align-folio",
        "validate",
        "generate-tei",
    ]
    assert audit["status"] == "aligned"
    assert (
        audit["runs"][0]["input_image_sha256"]
        == "9fcc33dc022d9bd49683e465e4b5134dc7fca46db47a414ea556f724490c1dba"
    )
    assert all("input_hashes" not in r for r in audit["runs"])
    assert all("seed_source" not in r for r in audit["runs"])

    # pipeline provenance: each corpus-level input recorded exactly once
    prov = json.loads((tmp_path / "provenance.json").read_text())
    assert prov["project_version"] == "0.1.0-dev"
    assert prov["seed"]["records"] == 1
    assert len(prov["seed"]["sha256"]) == 64
    assert len(prov["uxlc"]["zip_sha256"]) == 64
    assert prov["uxlc"]["files"] == 1
    assert prov["word_stream"]["words"] == len(word_stream["words"])
    assert len(prov["word_stream"]["sha256"]) == 64
    assert prov["index"]["path"].endswith("index.xml")
    assert prov["index"]["entries"] == 1

    # TEI: well-formed, 10 words + ADR 0002 verse/section milestones, one <change>
    # for the align-folio production event (checks and mechanics stay in audit)
    tei_xml = (tmp_path / "out" / "001B.xml").read_text()
    root = etree.fromstring(tei_xml.encode())
    ns = {"t": "http://www.tei-c.org/ns/1.0"}
    assert len(root.findall(".//t:w", ns)) == 10
    assert root.find(".//t:div[@type='edition']/t:ab", ns) is not None
    assert len(root.findall(".//t:milestone[@unit='verse']", ns)) == 5
    section = root.findall(".//t:milestone[@unit='section']", ns)
    assert [
        (s.get("subtype"), s.get("{%s}id" % "http://www.w3.org/XML/1998/namespace"))
        for s in section
    ] == [
        ("pe", "s-Genesis-1-3"),
        ("samekh", "s-Genesis-2-1"),
    ]
    changes = root.findall(".//t:revisionDesc/t:change", ns)
    assert len(changes) == 1
    assert changes[0].get("who") == "#leningrad-epidoc"
    assert "Aligned Genesis 1:1" in (changes[0].text or "")
    resp = root.find(".//t:titleStmt/t:respStmt", ns)
    assert resp is not None
    assert (
        resp.get("{http://www.w3.org/XML/1998/namespace}id") == "leningrad-epidoc"
    )
    graphic = root.find(".//t:sourceDesc/t:p/t:graphic", ns)
    assert graphic is not None
    assert graphic.get("url").endswith("BIB_LENCDX_F001B.jpg")
    idno = root.find(".//t:sourceDesc/t:p/t:idno[@type='sha256']", ns)
    assert idno is not None
    assert len(idno.text) == 64
    assert root.find(".//t:application", ns).get("version") == "0.1.0-dev"

    # index over the single folio
    index_root = etree.fromstring((tmp_path / "out" / "index.xml").read_text().encode())
    entries = index_root.findall("entry")
    assert len(entries) == 1
    assert entries[0].get("folio") == "001B"
    assert entries[0].get("href") == "001B.xml"


def test_validate_failure_does_not_mark_aligned(tmp_path: Path) -> None:
    """A corrupted alignment fails validation and leaves the status pending."""
    conf = _write_config(tmp_path)
    _run_pipeline(CliRunner(), conf)

    # corrupt the alignment artifact after the fact, then force a re-validate
    align_path = tmp_path / "alignments" / "001B.json"
    record = json.loads(align_path.read_text())
    record["columns"][0]["lines"][0]["atoms"] = []
    align_path.write_text(json.dumps(record))

    result = CliRunner().invoke(
        cli, ["--config", str(conf), "validate", "--folio", "001B"]
    )
    assert result.exit_code == 0
    assert "failed" in result.output

    audit = json.loads((tmp_path / "audit" / "001B.json").read_text())
    last_validate = [r for r in audit["runs"] if r["stage"] == "validate"][-1]
    assert last_validate["result_summary"]["passed"] is False
    assert audit["status"] == "aligned"  # unchanged: failure does not downgrade

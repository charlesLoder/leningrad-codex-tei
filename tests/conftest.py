"""Shared fixtures for the pipeline test suite."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from leningrad_epidoc.config import (
    AiConfig,
    Config,
    ImageConfig,
    PathsConfig,
    SeedConfig,
    UxlcConfig,
)

FIXTURES = Path(__file__).parent / "fixtures"


@pytest.fixture
def uxlc_fixture_dir(tmp_path: Path) -> Path:
    """A copy of the synthetic UXLC fixture dir at a writable location."""
    d = tmp_path / "uxlc"
    d.mkdir(parents=True)
    (d / "Genesis.xml").write_bytes((FIXTURES / "uxlc" / "Genesis.xml").read_bytes())
    return d


@pytest.fixture
def seed_fixture() -> dict:
    return json.loads((FIXTURES / "seed" / "lci_recs.json").read_text())


@pytest.fixture
def config(tmp_path: Path) -> Config:
    """Hermetic Config whose every output path lives under tmp_path."""
    return Config(
        project_name="leningrad-epidoc",
        project_version="0.1.0-dev",
        paths=PathsConfig(
            uxlc=tmp_path / "uxlc",
            seed=tmp_path / "seed" / "lci_recs.json",
            images=tmp_path / "images",
            output=tmp_path / "out",
            audit=tmp_path / "audit",
            alignments=tmp_path / "alignments",
            word_stream=tmp_path / "word_stream.json",
            provenance=tmp_path / "provenance.json",
        ),
        images=ImageConfig(
            base_url="https://example.invalid/",
            naming="BIB_LENCDX_F{folio}.jpg",
        ),
        seed=SeedConfig(
            upstream_url="https://github.com/example/codex-index-leningrad",
            commit="deadbee",
            file="UXLC-utils-sparse/data/lci_recs.json",
        ),
        uxlc=UxlcConfig(download_url="https://example.invalid/Books/Tanach.xml.zip"),
        ai=AiConfig(model="test-model", max_retries=3),
    )


@pytest.fixture
def word_stream(uxlc_fixture_dir: Path):
    from leningrad_epidoc.stages.word_stream import build_word_stream

    return build_word_stream(uxlc_fixture_dir, book_order=["Genesis"])


@pytest.fixture
def seed_slice(seed_fixture: dict, word_stream):
    from leningrad_epidoc.stages.align import compute_seed_slice

    return compute_seed_slice(seed_fixture, "001B", word_stream)  # Genesis 1:1 – 2:2
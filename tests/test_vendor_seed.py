"""Tests for the vendor-seed stage."""

from __future__ import annotations

import hashlib
import json

import pytest

from leningrad_codex_tei.stages.vendor_seed import vendor_seed


def test_vendor_seed_writes_pinned_seed(config, seed_fixture: dict) -> None:
    calls: list[str] = []

    def fetcher(url: str) -> bytes:
        calls.append(url)
        return json.dumps(seed_fixture).encode()

    info = vendor_seed(config, fetcher=fetcher)

    assert config.paths.seed.exists()
    assert json.loads(config.paths.seed.read_text()) == seed_fixture
    expected = hashlib.sha256(json.dumps(seed_fixture).encode()).hexdigest()
    assert info["sha256"] == expected
    assert info["records"] == 1

    assert len(calls) == 1
    assert "codex-index-leningrad" in calls[0]
    assert "deadbee" in calls[0]
    assert calls[0].endswith("/UXLC-utils-sparse/data/lci_recs.json")


def test_vendor_seed_creates_parent_directories(config, seed_fixture: dict) -> None:
    info = vendor_seed(config, fetcher=lambda url: json.dumps(seed_fixture).encode())
    assert config.paths.seed.parent.exists()


def test_vendor_seed_rejects_invalid_json(config) -> None:
    with pytest.raises(ValueError):
        vendor_seed(config, fetcher=lambda url: b"{not json")


def test_vendor_seed_rejects_missing_body(config) -> None:
    with pytest.raises(ValueError):
        vendor_seed(config, fetcher=lambda url: b'{"header": {}}')
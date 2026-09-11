"""Tests for the download-images stage."""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from leningrad_codex_tei.stages.download import download_image

JPEG_BYTES = b"\xff\xd8\xff\xe0fake-jpeg\xff\xd9"


def test_download_image_saves_and_hashes(config) -> None:
    calls: list[str] = []

    def fetcher(url: str) -> bytes:
        calls.append(url)
        return JPEG_BYTES

    info = download_image(config, "001B", fetcher=fetcher)

    expected_path = config.paths.images / "BIB_LENCDX_F001B.jpg"
    assert expected_path.exists()
    assert expected_path.read_bytes() == JPEG_BYTES
    assert info["sha256"] == hashlib.sha256(JPEG_BYTES).hexdigest()
    assert info["path"] == str(expected_path)

    assert len(calls) == 1
    assert calls[0].endswith("/BIB_LENCDX_F001B.jpg")


def test_download_image_creates_dir(config) -> None:
    download_image(config, "001B", fetcher=lambda url: JPEG_BYTES)
    assert config.paths.images.is_dir()


def test_download_image_propagates_fetch_errors(config) -> None:
    def boom(url: str) -> bytes:
        raise RuntimeError("offline")

    with pytest.raises(RuntimeError):
        download_image(config, "001B", fetcher=boom)


def test_download_image_writes_to_explicit_out_dir(config, tmp_path: Path) -> None:
    out = tmp_path / "custom"
    download_image(config, "001B", fetcher=lambda url: JPEG_BYTES, out_dir=out)
    assert (out / "BIB_LENCDX_F001B.jpg").read_bytes() == JPEG_BYTES
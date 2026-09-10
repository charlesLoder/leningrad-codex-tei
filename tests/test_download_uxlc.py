"""Tests for the download-uxlc stage."""

from __future__ import annotations

import hashlib
import io
import zipfile
from pathlib import Path

import pytest

from leningrad_epidoc.config import Config
from leningrad_epidoc.stages.uxlc import download_uxlc

UXLC_URL = "https://example.invalid/Books/Tanach.xml.zip"


def _make_zip(entries: dict[str, bytes] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as archive:
        for name, data in (entries or {"Genesis.xml": b"<foo/>"}).items():
            archive.writestr(name, data)
    return buf.getvalue()


def test_download_uxlc_extracts_and_cleans_up(config: Config) -> None:
    payload = _make_zip()
    calls: list[str] = []

    def fetcher(url: str) -> bytes:
        calls.append(url)
        return payload

    info = download_uxlc(config, fetcher=fetcher)

    assert (config.paths.uxlc / "Genesis.xml").read_bytes() == b"<foo/>"
    assert not list(config.paths.uxlc.glob("*.zip"))
    assert info["zip_sha256"] == hashlib.sha256(payload).hexdigest()
    assert info["files"] == 1
    assert info["zip_removed"] is True
    assert calls == [UXLC_URL]


def test_download_uxlc_creates_dir(config: Config) -> None:
    config.paths.uxlc = config.paths.uxlc / "nested" / "uxlc"
    download_uxlc(config, fetcher=lambda url: _make_zip())
    assert config.paths.uxlc.is_dir()


def test_download_uxlc_skips_directories_and_non_xml(config: Config) -> None:
    payload = _make_zip({
        "Genesis.xml": b"<a/>",
        "Exodus.xml": b"<b/>",
        "dir/Joshua.xml": b"<c/>",
        "README.txt": b"hi",
    })
    info = download_uxlc(config, fetcher=lambda url: payload)

    assert (config.paths.uxlc / "Genesis.xml").read_bytes() == b"<a/>"
    assert (config.paths.uxlc / "Exodus.xml").exists()
    assert (config.paths.uxlc / "Joshua.xml").read_bytes() == b"<c/>"
    assert not (config.paths.uxlc / "README.txt").exists()
    assert not (config.paths.uxlc / "dir").exists()
    assert info["files"] == 3


def test_download_uxlc_rejects_non_zip(config: Config) -> None:
    with pytest.raises(ValueError, match="not a zip archive"):
        download_uxlc(config, fetcher=lambda url: b"{not a zip")

    assert not list(config.paths.uxlc.iterdir())


def test_download_uxlc_writes_to_explicit_out_dir(config: Config, tmp_path: Path) -> None:
    out = tmp_path / "custom"
    download_uxlc(config, fetcher=lambda url: _make_zip(), out_dir=out)
    assert (out / "Genesis.xml").read_bytes() == b"<foo/>"
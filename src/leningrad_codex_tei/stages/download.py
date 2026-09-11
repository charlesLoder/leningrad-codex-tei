"""download-images stage: fetch a folio image and record its input hash."""

from __future__ import annotations

import hashlib
from pathlib import Path

from leningrad_codex_tei.config import Config
from leningrad_codex_tei.util import net


def image_url(config: Config, folio: str) -> str:
    if not config.images.naming:
        raise ValueError("images.naming is empty")
    file_name = config.images.naming.format(folio=folio)
    return f"{config.images.base_url.rstrip('/')}/{file_name}"


def download_image(config: Config, folio: str, fetcher=None, out_dir: Path | None = None) -> dict:
    """Fetch one folio image, write it to disk, and return hash metadata."""
    url = image_url(config, folio)
    data = (fetcher or net.fetch_url)(url)

    file_name = config.images.naming.format(folio=folio)
    dest = (out_dir or config.paths.images) / file_name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)

    return {
        "folio": folio,
        "url": url,
        "path": str(dest),
        "sha256": hashlib.sha256(data).hexdigest(),
    }
"""download-uxlc stage: fetch the UXLC book archive, extract its XML, and clean up."""

from __future__ import annotations

import hashlib
import zipfile
from pathlib import Path
from urllib.parse import urlparse

from leningrad_epidoc.config import Config
from leningrad_epidoc.util import net


def download_uxlc(config: Config, fetcher=None, out_dir: Path | None = None) -> dict:
    """Fetch the UXLC zip, extract its XML books into ``paths.uxlc``, then delete the zip."""
    url = config.uxlc.download_url
    dest_dir = (out_dir or config.paths.uxlc).resolve()
    dest_dir.mkdir(parents=True, exist_ok=True)

    data = (fetcher or net.fetch_url)(url)
    zip_name = Path(urlparse(url).path).name or "uxlc.zip"
    zip_path = dest_dir / zip_name
    zip_path.write_bytes(data)
    sha256 = hashlib.sha256(data).hexdigest()

    if not zipfile.is_zipfile(zip_path):
        zip_path.unlink(missing_ok=True)
        raise ValueError(f"downloaded UXLC payload at {url} is not a zip archive")

    extracted = 0
    with zipfile.ZipFile(zip_path) as archive:
        for member in archive.infolist():
            if member.is_dir():
                continue
            name = Path(member.filename).name
            if not name.endswith(".xml"):
                continue
            (dest_dir / name).write_bytes(archive.read(member))
            extracted += 1

    zip_path.unlink(missing_ok=True)

    return {
        "url": url,
        "path": str(dest_dir),
        "files": extracted,
        "zip_sha256": sha256,
        "zip_removed": True,
    }
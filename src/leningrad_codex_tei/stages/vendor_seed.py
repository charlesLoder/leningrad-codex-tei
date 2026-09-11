"""vendor-seed stage: download and pin the seed mapping."""

from __future__ import annotations

import hashlib
import json
from urllib.parse import urlparse

from leningrad_codex_tei.config import Config
from leningrad_codex_tei.util import net


def seed_url(config: Config) -> str:
    """raw URL for the pinned seed file, e.g. …/owner/repo/{commit}/path."""
    parsed = urlparse(config.seed.upstream_url)
    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 2:
        raise ValueError(f"cannot parse owner/repo from {config.seed.upstream_url}")
    owner, repo = parts[0], parts[1]
    return f"https://raw.githubusercontent.com/{owner}/{repo}/{config.seed.commit}/{config.seed.file}"


def vendor_seed(config: Config, fetcher=None) -> dict:
    """Fetch the seed JSON, validate its shape, and pin it at the config path."""
    url = seed_url(config)
    data = (fetcher or net.fetch_url)(url)

    try:
        doc = json.loads(data)
    except json.JSONDecodeError as exc:
        raise ValueError(f"seed at {url} is not valid JSON: {exc}") from exc
    if not isinstance(doc, dict) or "body" not in doc:
        raise ValueError(f"seed at {url} has no 'body' array")
    if not isinstance(doc["body"], list):
        raise ValueError(f"seed at {url} 'body' is not a list")

    path = config.paths.seed
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)

    return {
        "url": url,
        "commit": config.seed.commit,
        "snapshot_commit": config.seed.snapshot_commit,
        "sha256": hashlib.sha256(data).hexdigest(),
        "records": len(doc["body"]),
        "path": str(path),
    }

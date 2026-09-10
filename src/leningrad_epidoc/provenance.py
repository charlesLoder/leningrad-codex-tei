"""Provenance read/write: the per-folio audit trail and the pipeline ledger."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

from leningrad_epidoc.schemas import (
    AuditTrail,
    FolioStatus,
    IndexProvenance,
    PipelineProvenance,
    PipelineRun,
    RunStage,
    SeedProvenance,
    UxlcProvenance,
    WordStreamProvenance,
)


def _default(obj):
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, datetime):
        return obj.isoformat()
    return str(obj)


def audit_path(audit_dir: Path, folio: str) -> Path:
    return audit_dir / f"{folio}.json"


def load_audit(audit_dir: Path, folio: str) -> AuditTrail | None:
    p = audit_path(audit_dir, folio)
    if not p.exists():
        return None
    data = json.loads(p.read_text())
    return AuditTrail(
        folio=data["folio"],
        runs=[_pipeline_run(r) for r in data.get("runs", [])],
        status=FolioStatus(data["status"]),
        created_at=datetime.fromisoformat(data["created_at"]),
        updated_at=datetime.fromisoformat(data["updated_at"]),
    )


def _pipeline_run(data: dict) -> PipelineRun:
    return PipelineRun(
        stage=RunStage(data["stage"]),
        model=data.get("model"),
        temperature=data.get("temperature"),
        prompt_version=data.get("prompt_version"),
        repo_hash=data.get("repo_hash"),
        input_image_sha256=data.get("input_image_sha256"),
        checks=data.get("checks"),
        result_summary=data.get("result_summary"),
        timestamp=datetime.fromisoformat(data["timestamp"]) if data.get("timestamp") else None,
    )


def append_run(
    audit_dir: Path,
    folio: str,
    run: PipelineRun,
    status: FolioStatus | None = None,
) -> AuditTrail:
    """Add one stage run to the folio's trail, creating it if needed."""
    trail = load_audit(audit_dir, folio) or AuditTrail(folio=folio)
    if run.timestamp is None:
        run.timestamp = datetime.now(timezone.utc)
    trail.runs.append(run)
    trail.updated_at = datetime.now(timezone.utc)
    if status is not None:
        trail.status = status
    save_audit(audit_dir, trail)
    return trail


def save_audit(audit_dir: Path, trail: AuditTrail) -> None:
    audit_dir.mkdir(parents=True, exist_ok=True)
    p = audit_path(audit_dir, trail.folio)
    p.write_text(json.dumps(asdict(trail), indent=2, default=_default))


def load_pipeline_provenance(path: Path) -> PipelineProvenance:
    """Load the corpus-level provenance ledger, or a blank one if absent."""
    if not path.exists():
        return PipelineProvenance()
    data = json.loads(path.read_text())
    return PipelineProvenance(
        project_version=data.get("project_version"),
        seed=SeedProvenance(**data["seed"]) if data.get("seed") else None,
        uxlc=UxlcProvenance(**data["uxlc"]) if data.get("uxlc") else None,
        word_stream=WordStreamProvenance(**data["word_stream"]) if data.get("word_stream") else None,
        index=IndexProvenance(**data["index"]) if data.get("index") else None,
        updated_at=datetime.fromisoformat(data["updated_at"]),
    )


def save_pipeline_provenance(path: Path, prov: PipelineProvenance) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    prov.updated_at = datetime.now(timezone.utc)
    path.write_text(json.dumps(asdict(prov), indent=2, default=_default))


def update_pipeline_provenance(path: Path, project_version: str, **sections) -> PipelineProvenance:
    """Set one or more sections of the pipeline ledger, creating it if needed."""
    prov = load_pipeline_provenance(path)
    prov.project_version = project_version
    for name, value in sections.items():
        if value is not None:
            setattr(prov, name, value)
    save_pipeline_provenance(path, prov)
    return prov
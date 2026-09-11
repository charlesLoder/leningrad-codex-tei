"""generate-tei stage: render a per-folio EpiDoc file from templates."""

from __future__ import annotations

from pathlib import Path

from jinja2 import Environment, FileSystemLoader, select_autoescape

from leningrad_epidoc.schemas import AlignmentRecord, PipelineRun, RunStage

TEMPLATE_DIR = Path(__file__).resolve().parents[3] / "templates"

REPO_URL = "https://github.com/charlesLoder/leningrad-epidoc"


def repo_snapshot_url(repo_hash: str) -> str | None:
    """GitHub snapshot URL for a repo hash, or None when unknown."""
    if not repo_hash or repo_hash == "unknown":
        return None
    return f"{REPO_URL}/commit/{repo_hash.removesuffix('-dirty')}"

_env = Environment(
    loader=FileSystemLoader(str(TEMPLATE_DIR)),
    autoescape=select_autoescape(["xml"]),
    trim_blocks=True,
    lstrip_blocks=True,
)


def render_folio_tei(
    *,
    folio: str,
    verse_range: str,
    record: AlignmentRecord,
    page_milestones: list[dict],
    changes: list[dict],
    pipeline_version: str,
    repo_hash: str = "unknown",
    generated_when: str | None = None,
    source_image: dict | None = None,
) -> str:
    """Render a well-formed TEI document for one folio."""
    template = _env.get_template("tei_folio.xml.j2")
    return template.render(
        folio=folio,
        verse_range=verse_range,
        columns=_annotate_columns(record),
        page_milestones=page_milestones,
        changes=changes,
        pipeline_version=pipeline_version,
        repo_hash=repo_hash,
        repo_url=REPO_URL,
        repo_snapshot_url=repo_snapshot_url(repo_hash),
        generated_when=generated_when,
        source_image=source_image,
    )


def _milestone_id(verse: str) -> str:
    """\"Genesis 1:1\" -> \"Genesis-1-1\" for xml:id attributes."""
    return verse.replace(" ", "-").replace(":", "-")


def _annotate_columns(record: AlignmentRecord) -> list[dict]:
    """Flatten columns into line entries carrying ADR 0002 milestone info.

    The verse and section milestones are supplied by the alignment record
    (derived once from UXLC by align-folio); this stage only attaches them to
    the matching column+line for rendering.
    """
    verse_by_loc: dict[tuple[int, int], dict] = {}
    for vm in record.verse_milestones:
        ref = _milestone_id(vm.verse)
        verse_by_loc[(vm.column, vm.line)] = {
            "n": ref,
            "id": ref,
        }
    section_by_loc: dict[tuple[int, int], tuple[str, str]] = {}
    for sm in record.section_milestones:
        section_by_loc[(sm.column, sm.line)] = (sm.subtype, _milestone_id(sm.verse))

    flat = [(cix, line) for cix, col in enumerate(record.columns) for line in col.lines]
    annotated: list[tuple[int, dict]] = []
    for cix, line in flat:
        loc = (record.columns[cix].column_number, line.line_number)
        verse = verse_by_loc.get(loc)
        section = section_by_loc.get(loc)
        entry = {
            "line_number": line.line_number,
            "verse_milestone": verse is not None,
            "verse_n": verse["n"] if verse else None,
            "verse_id": verse["id"] if verse else None,
            "section_milestone": section[0] if section else None,
            "section_id": section[1] if section else None,
            "atoms": line.atoms,
        }
        annotated.append((cix, entry))

    cols: dict[int, dict] = {}
    for cix, entry in annotated:
        cols.setdefault(
            cix, {"column_number": record.columns[cix].column_number, "lines": []}
        )["lines"].append(entry)
    return [cols[k] for k in sorted(cols)]


def changes_from_audit(runs: list[PipelineRun]) -> list[dict]:
    """Align-folio production events as revisionDesc changes, most recent first.

    Only alignment runs belong in the artifact: downloads, checks, and
    rendering mechanics stay in the audit trail.
    """
    changes: list[dict] = []
    for run in runs:
        if run.stage != RunStage.ALIGN_FOLIO:
            continue
        changes.append(
            {
                "when": run.timestamp.isoformat() if run.timestamp else "",
                "text": _change_text(run),
                "features": _ai_features(run),
            }
        )
    changes.reverse()
    return changes


def _change_text(run: PipelineRun) -> str:
    summary = run.result_summary if isinstance(run.result_summary, dict) else {}
    if "range" in summary and "atoms" in summary:
        text = f"Aligned {summary['range']} ({summary['atoms']} atoms"
        if summary.get("method"):
            text += f", {summary['method']}"
        return text + ")."
    return "Aligned folio."


def source_image_from_audit(runs: list[PipelineRun]) -> dict | None:
    """Latest download-images run as {url, sha256} for the sourceDesc."""
    for run in reversed(runs):
        if run.stage != RunStage.DOWNLOAD_IMAGES:
            continue
        summary = run.result_summary if isinstance(run.result_summary, dict) else {}
        url = summary.get("url")
        sha256 = run.input_image_sha256 or summary.get("sha256")
        if url is None and sha256 is None:
            return None
        return {"url": url, "sha256": sha256}
    return None


_AI_PARAM_ORDER = (
    "stage",
    "model",
    "temperature",
    "prompt_version",
    "repo_hash",
    "inference",
    "code_execution",
    "max_retries",
    "image_transport",
    "thinking_level",
)


def _ai_features(run: PipelineRun) -> list[dict]:
    """Ordered ai-params features for one run, empty when it used no model."""
    if run.model is None:
        return []
    entry: dict = {
        "stage": run.stage.value,
        "model": run.model,
        "temperature": run.temperature,
        "prompt_version": run.prompt_version,
        "repo_hash": run.repo_hash,
    }
    ai = (
        (run.result_summary or {}).get("ai")
        if isinstance(run.result_summary, dict)
        else None
    )
    if isinstance(ai, dict):
        for key in (
            "inference",
            "code_execution",
            "max_retries",
            "image_transport",
            "thinking_level",
        ):
            if key in ai:
                entry[key] = ai[key]
    return [
        {"name": key, "value": str(entry[key])}
        for key in _AI_PARAM_ORDER
        if key in entry and entry[key] is not None
    ]

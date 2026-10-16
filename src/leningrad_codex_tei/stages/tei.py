"""generate-tei stage: render a per-folio TEI file from templates."""

from __future__ import annotations

from pathlib import Path
import re

from jinja2 import Environment, FileSystemLoader, select_autoescape

from leningrad_codex_tei.schemas import AlignmentRecord, PipelineRun, RunStage

TEMPLATE_DIR = Path(__file__).resolve().parents[3] / "templates"

REPO_URL = "https://github.com/charlesLoder/leningrad-codex-tei"

PROMPT_REPO_PATH = "src/leningrad_codex_tei/stages/align.py"


def repo_snapshot_url(repo_hash: str) -> str | None:
    """GitHub snapshot URL for a repo hash, or None when unknown."""
    if not repo_hash or repo_hash == "unknown":
        return None
    return f"{REPO_URL}/commit/{repo_hash.removesuffix('-dirty')}"


def prompt_snapshot_url(repo_hash: str | None) -> str | None:
    """GitHub blob URL for the align prompt at a repo hash, or None."""
    if not repo_hash or repo_hash == "unknown":
        return None
    return f"{REPO_URL}/blob/{repo_hash.removesuffix('-dirty')}/{PROMPT_REPO_PATH}"


_env = Environment(
    loader=FileSystemLoader(str(TEMPLATE_DIR)),
    autoescape=select_autoescape(["xml"]),
    trim_blocks=True,
    lstrip_blocks=True,
)


SOF_PASUQ = "\u05c3"
PASEQ = "\u05c0"

_PUNCT_TYPES = {
    SOF_PASUQ: "sof-pasuq",
    PASEQ: "paseq",
}


def split_trailing_punct(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Split trailing sof-pasuq / paseq off a UXLC atom string.

    The UXLC keeps one space before paseq inside the word
    (e.g. Genesis 1:5 atom 2 ends with U+0020 + U+05C0).
    The TEI keeps no trailing space in <w>.
    The paseq goes to <pc>.

    Returns (word_text, [(punct_char, punct_type), ...]) in document order.
    """
    marks: list[tuple[str, str]] = []
    cut = len(text)
    while cut > 0 and text[cut - 1] in _PUNCT_TYPES:
        char = text[cut - 1]
        marks.append((char, _PUNCT_TYPES[char]))
        cut -= 1
    marks.reverse()
    base = text[:cut]
    if marks and base.endswith(" "):
        base = base[:-1]
    return base, marks


def contributor_xml_id(name: str | None, email: str | None) -> str:
    """Stable ``respStmt`` id for a human contributor (TEI ``who`` target)."""
    base = re.sub(r"[^a-z0-9]+", "-", (name or email or "contributor").lower()).strip(
        "-"
    )
    return f"contrib-{base}" if base else "contrib-unknown"


def _run_contributor(run: PipelineRun) -> dict | None:
    if not run.contributor_name and not run.contributor_email:
        return None
    name = run.contributor_name or run.contributor_email
    return {
        "name": name,
        "email": run.contributor_email,
        "xml_id": contributor_xml_id(run.contributor_name, run.contributor_email),
    }


def contributors_from_audit(runs: list[PipelineRun]) -> list[dict]:
    """Distinct human contributors across runs, first-seen order.

    Download-batch runs stay in the audit trail only and never surface
    in the TEI.
    """
    seen: dict[str, dict] = {}
    for run in runs:
        if run.stage == RunStage.DOWNLOAD_BATCH:
            continue
        contrib = _run_contributor(run)
        if contrib is None:
            continue
        xml_id = contrib["xml_id"]
        if xml_id in seen:
            continue
        seen[xml_id] = contrib
    return list(seen.values())


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
    contributors: list[dict] | None = None,
    uxlc_edition: dict | None = None,
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
        contributors=contributors or [],
        uxlc_edition=uxlc_edition,
    )


def _milestone_id(verse: str) -> str:
    """\"Genesis 1:1\" -> \"Genesis-1-1\" for xml:id attributes."""
    return verse.replace(" ", "-").replace(":", "-")


INVERTED_NUN_CHAR = "\u05c6"

_PC_ID_FOR_INVERTED_NUN = "pc-{atom}-nun"


def _annotate_columns(record: AlignmentRecord) -> list[dict]:
    """Flatten columns into line entries carrying ADR 0002 milestone info.

    The verse and section milestones are supplied by the alignment record
    (derived once from UXLC by align-folio); this stage interleaves them at
    word boundaries so a verse starting or ending mid-line is emitted
    between its words rather than at the line edge.

    Word text stays as in the UXLC. No reorder. Up to v1 the TEI
    must match UXLC code points.

    Trailing sof-pasuq / paseq are split off each atom into
    ``pc`` tokens. The ``w`` keeps the UXLC atom number; each ``pc`` takes
    a derived ``pc-{atom}`` id (``pc-{atom}-{n}`` when one atom yields
    several marks) so validation stays atom-faithful.
    """
    verse_by_atom: dict[int, dict] = {}
    for vm in record.verse_milestones:
        ref = _milestone_id(vm.verse)
        verse_by_atom[vm.atom] = {
            "n": ref,
            "id": ref,
        }
    section_by_atom: dict[int, list[tuple[str, str]]] = {}
    used_section_ids: set[str] = set()
    for sm in record.section_milestones:
        base = _milestone_id(sm.verse)
        sid = base
        if sid in used_section_ids:
            sid = f"{base}-{sm.subtype}"
        used_section_ids.add(sid)
        section_by_atom.setdefault(sm.atom, []).append((sm.subtype, sid))

    flat = [(cix, line) for cix, col in enumerate(record.columns) for line in col.lines]
    annotated: list[tuple[int, dict]] = []
    for cix, line in flat:
        atoms = list(line.atoms)
        tokens: list[dict] = []
        for w in atoms:
            verse = verse_by_atom.get(w.atom)
            if verse is not None:
                tokens.append({"kind": "verse", "n": verse["n"], "id": verse["id"]})
            base, marks = split_trailing_punct(w.text)
            if base:
                tokens.append({"kind": "w", "atom": w.atom, "text": base})
            for i, (char, punct_type) in enumerate(marks):
                if len(marks) == 1:
                    pc_id = f"pc-{w.atom}"
                else:
                    pc_id = f"pc-{w.atom}-{i + 1}"
                tokens.append(
                    {
                        "kind": "pc",
                        "atom": w.atom,
                        "text": char,
                        "pc_type": punct_type,
                        "pc_id": pc_id,
                    }
                )
            if not base and not marks:
                tokens.append({"kind": "w", "atom": w.atom, "text": w.text})
            for section_subtype, section_id in section_by_atom.get(w.atom, []):
                tokens.append(
                    {"kind": "section", "subtype": section_subtype, "id": section_id}
                )
                if section_subtype == "inverted-nun":
                    tokens.append(
                        {
                            "kind": "pc",
                            "atom": w.atom,
                            "text": INVERTED_NUN_CHAR,
                            "pc_type": "inverted-nun",
                            "pc_id": _PC_ID_FOR_INVERTED_NUN.format(atom=w.atom),
                        }
                    )
        entry = {
            "line_number": line.line_number,
            "atoms": atoms,
            "tokens": tokens,
        }
        annotated.append((cix, entry))

    cols: dict[int, dict] = {}
    for cix, entry in annotated:
        cols.setdefault(
            cix, {"column_number": record.columns[cix].column_number, "lines": []}
        )["lines"].append(entry)
    result: list[dict] = []
    for k in sorted(cols):
        col = cols[k]
        col["lines"].sort(key=lambda e: e["line_number"])
        filled: list[dict] = []
        for entry in col["lines"]:
            first = filled[-1]["line_number"] + 1 if filled else 1
            for missing in range(first, entry["line_number"]):
                filled.append({"line_number": missing, "atoms": [], "tokens": []})
            filled.append(entry)
        col["lines"] = filled
        result.append(col)
    return result


def changes_from_audit(runs: list[PipelineRun]) -> list[dict]:
    """Production events as revisionDesc changes, most recent first.

    Only the last align-folio run is emitted, since it represents the
    data used; earlier alignments are superseded. Download-batch runs
    record the machine fetch event and stay in the audit trail, never
    in the TEI. Generate-tei runs with a contributor record the human
    encoder, one entry per contributor (latest run wins), so re-running
    generate-tei does not repeat the same "Encoded by" change.
    Downloads, checks, and other mechanics stay in the audit
    trail.
    """
    last_align = max(
        (i for i, run in enumerate(runs) if run.stage == RunStage.ALIGN_FOLIO),
        default=None,
    )
    last_generate_by_who: dict[str, int] = {}
    for i, run in enumerate(runs):
        if run.stage != RunStage.GENERATE_TEI:
            continue
        contrib = _run_contributor(run)
        if contrib is None:
            continue
        last_generate_by_who[contrib["xml_id"]] = i
    changes: list[dict] = []
    for i, run in enumerate(runs):
        if run.stage == RunStage.ALIGN_FOLIO and i != last_align:
            continue
        if run.stage == RunStage.ALIGN_FOLIO:
            contrib = _run_contributor(run)
            changes.append(
                {
                    "when": run.timestamp.isoformat() if run.timestamp else "",
                    "who": f"#{contrib['xml_id']}"
                    if contrib
                    else "#leningrad-codex-tei",
                    "text": _change_text(run),
                    "features": _ai_features(run),
                    "prompt_url": prompt_snapshot_url(run.repo_hash),
                }
            )
        elif run.stage == RunStage.GENERATE_TEI:
            contrib = _run_contributor(run)
            if contrib is None:
                continue
            if i != last_generate_by_who[contrib["xml_id"]]:
                continue
            changes.append(
                {
                    "when": run.timestamp.isoformat() if run.timestamp else "",
                    "who": f"#{contrib['xml_id']}",
                    "text": f"Encoded by {contrib['name']}.",
                    "features": [],
                    "prompt_url": None,
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

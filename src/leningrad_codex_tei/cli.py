"""Leningrad Codex TEI pipeline — CLI entry point."""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict
from pathlib import Path

import click

from leningrad_codex_tei.config import Config, load_config
from leningrad_codex_tei.provenance import append_run, update_pipeline_provenance
from leningrad_codex_tei.schemas import (
    FolioStatus,
    IndexProvenance,
    PipelineRun,
    RunStage,
    SeedProvenance,
    UxlcProvenance,
    WordStreamProvenance,
)
from leningrad_codex_tei.stages import align as align_stage
from leningrad_codex_tei.stages import download as download_stage
from leningrad_codex_tei.stages import index as index_stage
from leningrad_codex_tei.stages import tei as tei_stage
from leningrad_codex_tei.stages import uxlc as uxlc_stage
from leningrad_codex_tei.stages import validate as validate_stage
from leningrad_codex_tei.stages import vendor_seed as vendor_seed_stage
from leningrad_codex_tei.stages import word_stream as stream_stage
from leningrad_codex_tei.util.git import contributor_info as _contributor_info
from leningrad_codex_tei.util.git import repo_hash as _repo_hash


def _current_contributor() -> dict | None:
    """Human contributor from git config, or None when unconfigured."""
    try:
        return _contributor_info()
    except Exception:
        return None


def _file_sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _seed_folios(config: Config) -> list[str]:
    doc = json.loads(config.paths.seed.read_text())
    return [rec["page"] for rec in doc["body"]]


def _alignment_folios(config: Config) -> list[str]:
    return sorted(p.stem for p in config.paths.alignments.glob("*.json"))


def _load_pipeline(config: Config, folio: str):
    seed = json.loads(config.paths.seed.read_text())
    stream = stream_stage.load_word_stream(config.paths.word_stream)
    sl = align_stage.compute_seed_slice(seed, folio, stream)
    record = align_stage.load_alignment(config.paths.alignments / f"{folio}.json")
    return seed, stream, sl, record


@click.group()
@click.version_option(version="0.1.0")
@click.option(
    "--config",
    "config_path",
    default="config.yaml",
    show_default=True,
    help="Path to the pipeline config file.",
)
@click.pass_context
def cli(ctx: click.Context, config_path: str) -> None:
    """Pipeline for generating an TEI-encoded Leningrad Codex."""
    ctx.obj = load_config(Path(config_path))


@cli.command()
@click.pass_obj
def vendor_seed(config: Config) -> None:
    """Download and pin the seed mapping (lci_recs.json)."""
    info = vendor_seed_stage.vendor_seed(config)
    update_pipeline_provenance(
        config.paths.provenance, config.project_version, seed=SeedProvenance(**info)
    )
    click.echo(
        f"vendor-seed: {config.paths.seed} ({info['records']} records, sha256 {info['sha256'][:12]}…)"
    )


@cli.command()
@click.pass_obj
def download_uxlc(config: Config) -> None:
    """Fetch and extract the UXLC book XMLs from the archive URL, then clean up."""
    info = uxlc_stage.download_uxlc(config)
    update_pipeline_provenance(
        config.paths.provenance,
        config.project_version,
        uxlc=UxlcProvenance(
            url=info["url"],
            path=info["path"],
            files=info["files"],
            zip_sha256=info["zip_sha256"],
        ),
    )
    click.echo(
        f"download-uxlc: {config.paths.uxlc} ({info['files']} XML files, zip sha256 {info['zip_sha256'][:12]}…)"
    )


@cli.command()
@click.option("--folio", help="Process a single folio (e.g. 001B). Omit for all.")
@click.pass_obj
def download_images(config: Config, folio: str | None) -> None:
    """Fetch folio images from the configured source, record input hashes."""
    folios = [folio] if folio else _seed_folios(config)
    for page in folios:
        info = download_stage.download_image(config, page)
        append_run(
            config.paths.audit,
            page,
            PipelineRun(
                stage=RunStage.DOWNLOAD_IMAGES,
                input_image_sha256=info["sha256"],
                result_summary=info,
            ),
        )
        click.echo(
            f"download-images: {info['folio']} -> {info['path']} (sha256 {info['sha256'][:12]}…)"
        )


@cli.command()
@click.pass_obj
def build_word_stream(config: Config) -> None:
    """Parse UXLC XML files into a flat word stream with atom IDs."""
    stream = stream_stage.build_word_stream(config.paths.uxlc)
    stream_stage.save_word_stream(stream, config.paths.word_stream)
    sha = _file_sha(config.paths.word_stream)
    edition = stream.uxlc_edition
    update_pipeline_provenance(
        config.paths.provenance,
        config.project_version,
        word_stream=WordStreamProvenance(
            source=stream.source,
            sha256=sha,
            words=len(stream.words),
            path=str(config.paths.word_stream),
            uxlc_version=edition.version if edition else None,
            uxlc_date=edition.date if edition else None,
            uxlc_build=edition.build if edition else None,
            uxlc_build_datetime=edition.build_datetime if edition else None,
        ),
    )
    click.echo(
        f"build-word-stream: {len(stream.words)} words -> {config.paths.word_stream}"
    )


def _apply_ai_overrides(
    config: Config,
    *,
    model: str | None,
    temperature: float | None,
    inference: str | None,
    max_retries: int | None,
    code_execution: bool | None,
    base_delay: float | None,
    timeout_ms: int | None,
    fallback_to_standard: bool | None,
    image_transport: str | None,
    thinking_level: str | None,
) -> None:
    """Override the config ai block in-memory from CLI flags."""
    if model is not None:
        config.ai.model = model
    if temperature is not None:
        config.ai.temperature = temperature
    if inference is not None:
        if inference not in ("standard", "flex", "batch"):
            raise click.ClickException(
                f"--inference must be one of standard|flex|batch, got {inference!r}"
            )
        config.ai.inference = inference
    if max_retries is not None:
        config.ai.max_retries = max_retries
    if code_execution is not None:
        config.ai.code_execution = code_execution
    if base_delay is not None:
        config.ai.base_delay = base_delay
    if timeout_ms is not None:
        config.ai.timeout_ms = timeout_ms
    if fallback_to_standard is not None:
        config.ai.fallback_to_standard = fallback_to_standard
    if image_transport is not None:
        config.ai.image_transport = image_transport
    if thinking_level is not None:
        if thinking_level not in ("low", "medium", "high"):
            raise click.ClickException(
                f"--thinking-level must be one of low|medium|high, got {thinking_level!r}"
            )
        config.ai.thinking_level = thinking_level
    try:
        align_stage.check_image_transport(config)
    except ValueError as exc:
        raise click.ClickException(str(exc)) from exc
    if config.ai.inference in ("standard", "flex") and (
        config.ai.image_transport == "encode"
    ):
        click.echo(
            f'warning: ai.image_transport is "encode"; '
            f'"upload" is preferred for "{config.ai.inference}" inference',
            err=True,
        )


@cli.command()
@click.option(
    "--folio",
    default=None,
    help="Start folio (e.g. 001B). Aligns --limit folios from here.",
)
@click.option(
    "--limit", type=int, default=None, help="Folios to align from --folio. Default 1."
)
@click.option("--all", "all_", is_flag=True, help="Align all folios in seed order.")
@click.option("--model", default=None, help="Override ai.model.")
@click.option(
    "--temperature", type=float, default=None, help="Override ai.temperature."
)
@click.option(
    "--inference",
    type=click.Choice(["standard", "flex", "batch"]),
    default=None,
    help="Override ai.inference.",
)
@click.option("--max-retries", type=int, default=None, help="Override ai.max_retries.")
@click.option(
    "--code-execution/--no-code-execution",
    default=None,
    help="Override ai.code_execution.",
)
@click.option("--base-delay", type=float, default=None, help="Override ai.base_delay.")
@click.option("--timeout-ms", type=int, default=None, help="Override ai.timeout_ms.")
@click.option(
    "--fallback-to-standard/--no-fallback-to-standard",
    "fallback_to_standard",
    default=None,
    help="Override ai.fallback_to_standard.",
)
@click.option(
    "--image-transport",
    type=click.Choice(["encode", "upload"]),
    default=None,
    help="Override ai.image_transport.",
)
@click.option(
    "--thinking-level",
    type=click.Choice(["low", "medium", "high"]),
    default=None,
    help="Override ai.thinking_level.",
)
@click.pass_obj
def align_folio(
    config: Config,
    folio: str | None,
    limit: int | None,
    all_: bool,
    model: str | None,
    temperature: float | None,
    inference: str | None,
    max_retries: int | None,
    code_execution: bool | None,
    base_delay: float | None,
    timeout_ms: int | None,
    fallback_to_standard: bool | None,
    image_transport: str | None,
    thinking_level: str | None,
) -> None:
    """Align seed mapping to folios' layout via a vision model."""
    try:
        align_stage.ensure_align_prompt_clean()
    except RuntimeError as exc:
        raise click.ClickException(str(exc)) from exc
    _apply_ai_overrides(
        config,
        model=model,
        temperature=temperature,
        inference=inference,
        max_retries=max_retries,
        code_execution=code_execution,
        base_delay=base_delay,
        timeout_ms=timeout_ms,
        fallback_to_standard=fallback_to_standard,
        image_transport=image_transport,
        thinking_level=thinking_level,
    )
    seed = json.loads(config.paths.seed.read_text())
    stream = stream_stage.load_word_stream(config.paths.word_stream)
    if all_:
        if folio is not None or limit is not None:
            raise click.ClickException("--all cannot be used with --folio or --limit")
        folios = _seed_folios(config)
    else:
        if folio is None:
            if limit is not None:
                raise click.ClickException("--limit requires --folio")
            raise click.ClickException(
                "Missing selection: pass --folio FOLIO [--limit N] or --all"
            )
        if limit is None:
            limit = 1
        if limit < 1:
            raise click.ClickException("--limit must be >= 1")
        ordered = _seed_folios(config)
        if folio not in ordered:
            raise click.ClickException(f"unknown folio {folio!r}")
        folios = ordered[ordered.index(folio) : ordered.index(folio) + limit]
    contributor = _current_contributor()
    if config.ai.inference == "batch":
        slices = [align_stage.compute_seed_slice(seed, page, stream) for page in folios]
        batch_record = align_stage.submit_batch(slices, stream, config)
        for page in folios:
            append_run(
                config.paths.audit,
                page,
                PipelineRun(
                    stage=RunStage.ALIGN_FOLIO,
                    model=config.ai.model,
                    temperature=config.ai.temperature,
                    prompt_version=align_stage.PROMPT_VERSION,
                    repo_hash=_repo_hash(),
                    contributor_name=(contributor or {}).get("name"),
                    contributor_email=(contributor or {}).get("email"),
                    result_summary={
                        "batch_job": batch_record["job_name"],
                        "upload_path": batch_record["upload_path"],
                        "batch_record": str(
                            config.paths.alignments
                            / "batch"
                            / batch_record["timestamp"]
                            / "submit.json"
                        ),
                        "ai": batch_record["ai"],
                    },
                ),
            )
        click.echo(
            f"align-folio (batch): {len(folios)} folios -> {batch_record['job_name']} "
            f"(upload {batch_record['upload_path']})"
        )
        return
    for page in folios:
        sl = align_stage.compute_seed_slice(seed, page, stream)
        record = align_stage.align_folio_ai(sl, stream, config)
        dest = config.paths.alignments / f"{page}.json"
        align_stage.save_alignment(record, dest)
        append_run(
            config.paths.audit,
            page,
            PipelineRun(
                stage=RunStage.ALIGN_FOLIO,
                model=config.ai.model,
                temperature=config.ai.temperature,
                prompt_version=align_stage.PROMPT_VERSION,
                repo_hash=_repo_hash(),
                contributor_name=(contributor or {}).get("name"),
                contributor_email=(contributor or {}).get("email"),
                result_summary={
                    "method": record.alignment_method.value,
                    "atoms": sl.atom_end - sl.atom_start + 1,
                    "range": f"{sl.start_ref} – {sl.stop_ref}",
                    "path": str(dest),
                    "conversation": str(
                        config.paths.alignments / "conversations" / f"{page}.json"
                    ),
                    "ai": align_stage.ai_snapshot(config),
                },
            ),
        )
        click.echo(
            f"align-folio: {page} = {sl.start_ref} – {sl.stop_ref} ({record.alignment_method.value}) -> {dest}"
        )


@cli.command(name="download-batch")
@click.option(
    "--batch",
    "batch",
    default=None,
    help="Batch timestamp (e.g. 20260905T223341), job dir, path to submit.json, or job name (e.g. batches/abc). Omit for latest.",
)
@click.pass_obj
def download_batch(config: Config, batch: str | None) -> None:
    """Poll a batch job and download its raw responses for later review.

    This is the only place where the prompt actually sent (from the batch
    record) and the reply actually received (from the result file) meet, so
    it also writes the faithful per-folio conversation files. Parsing those
    replies into alignments is left to parse-raw.
    """
    batch_dir = config.paths.alignments / "batch"
    job_dir, record = align_stage.resolve_batch_job_dir(batch_dir, batch)
    if record is None:
        raise click.ClickException(f"no batch record found for {batch}")
    job_name = record["job_name"]
    prompts: dict[str, str] = (record or {}).get("prompts", {})
    stored_prompt_version = (record or {}).get("prompt_version")

    client = align_stage._model_client(config)
    job = client.batches.get(name=job_name)
    poll_path = align_stage.write_poll_record(job_dir, job)
    status = align_stage.job_state_name(job)
    click.echo(f"download-batch: {job_name} status {status} (poll {poll_path})")
    if status != "JOB_STATE_SUCCEEDED":
        return

    result_file = align_stage.batch_result_file_name(job)
    if not result_file:
        raise click.ClickException(f"batch job {job_name} has no result file")
    payload = client.files.download(file=result_file)
    text = (
        payload.decode("utf-8")
        if isinstance(payload, (bytes, bytearray))
        else str(payload)
    )
    (job_dir / "result.jsonl").write_text(text, encoding="utf-8")

    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise click.ClickException(f"batch result file {result_file} is empty")
    texts, errors = align_stage.split_batch_result_lines(lines)
    saved: list[str] = []
    contributor = _current_contributor()
    for key, response_text in texts.items():
        prompt = prompts.get(key)
        if prompt is None:
            errors[key] = {"kind": "missing_prompt", "raw_saved": True}
            click.echo(
                f"download-batch: {key} has no stored prompt in {job_dir}; "
                f"raw saved without conversation",
                err=True,
            )
        raw_path = align_stage.save_raw_model_response(
            config.paths.alignments, key, response_text
        )
        raw_sha = hashlib.sha256(response_text.encode("utf-8")).hexdigest()
        if prompt is not None:
            image_path = config.paths.images / config.images.naming.format(folio=key)
            conversation = align_stage.build_conversation(
                folio=key,
                prompt=prompt,
                image_uri=str(image_path),
                model=config.ai.model,
                prompt_version=stored_prompt_version or align_stage.PROMPT_VERSION,
                inference=config.ai.inference,
                response_text=response_text,
                ai={**align_stage.ai_snapshot(config), "batch_job": job_name},
            )
            conv_path = align_stage.save_conversation(
                conversation, config.paths.alignments, key
            )
        else:
            conv_path = None
        append_run(
            config.paths.audit,
            key,
            PipelineRun(
                stage=RunStage.DOWNLOAD_BATCH,
                model=config.ai.model,
                temperature=config.ai.temperature,
                prompt_version=stored_prompt_version or align_stage.PROMPT_VERSION,
                repo_hash=_repo_hash(),
                contributor_name=(contributor or {}).get("name"),
                contributor_email=(contributor or {}).get("email"),
                result_summary={
                    "batch_job": job_name,
                    "raw": str(raw_path),
                    "raw_sha256": raw_sha,
                    "conversation": str(conv_path) if conv_path else None,
                    "ai": align_stage.ai_snapshot(config),
                },
            ),
        )
        saved.append(key)
        click.echo(f"download-batch: {key} raw -> {raw_path}")
    for key, detail in errors.items():
        if key not in texts:
            click.echo(f"download-batch: {key} error {detail}", err=True)
    summary_path = job_dir / "download.json"
    summary_path.write_text(
        json.dumps(
            {
                "job_name": job_name,
                "poll": str(poll_path),
                "saved": saved,
                "failed": sorted(errors),
                "failures": errors,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    click.echo(
        f"download-batch: saved {len(saved)}/{len(lines)} raw responses "
        f"({len(errors)} failed)"
        + (f": {', '.join(sorted(errors))}" if errors else "")
        + f" (summary {summary_path})"
    )
    click.echo("download-batch: next run parse-raw to parse raw responses")


@cli.command(name="parse-raw")
@click.option(
    "--folio",
    "folio",
    default=None,
    help="Parse a single folio (e.g. 028A) from its raw response. Omit to parse everything in raw/.",
)
@click.pass_obj
def parse_raw(config: Config, folio: str | None) -> None:
    """Parse raw model responses into alignment records.

    Reads ``alignments/raw/{folio}.xml`` (editable) so a hand-fixed model
    reply can be re-parsed without re-downloading. Slices are recomputed
    from the current seed file. With ``--folio`` only that folio is parsed;
    otherwise every raw response is parsed. Conversations are owned by
    ``download-batch`` and left alone here.
    """
    raw_dir = config.paths.alignments / "raw"
    if folio is not None:
        folios = [folio]
    else:
        folios = (
            sorted(p.stem for p in raw_dir.glob("*.xml")) if raw_dir.exists() else []
        )
    if not folios:
        if folio is not None:
            raise click.ClickException(
                f"no raw response for {folio!r} in {raw_dir} "
                f"(run download-batch first)"
            )
        raise click.ClickException(f"no raw responses in {raw_dir}")

    seed = json.loads(config.paths.seed.read_text())
    stream = stream_stage.load_word_stream(config.paths.word_stream)
    done = 0
    failed = 0
    failed_folios: list[str] = []
    failures: dict[str, dict] = {}
    succeeded: list[str] = []
    for key in folios:
        raw_path = raw_dir / f"{key}.xml"
        conv_path = config.paths.alignments / "conversations" / f"{key}.json"
        if not raw_path.exists():
            failed += 1
            failed_folios.append(key)
            failures[key] = {"kind": "missing_raw", "raw": str(raw_path)}
            click.echo(
                f"parse-raw: {key} missing raw response {raw_path} "
                f"(run download-batch first)",
                err=True,
            )
            continue
        try:
            sl = align_stage.compute_seed_slice(seed, key, stream)
        except Exception as exc:  # noqa: BLE001 - persist others, report this one
            failed += 1
            failed_folios.append(key)
            failures[key] = {
                "kind": "seed_error",
                "type": type(exc).__name__,
                "message": str(exc),
                "raw": str(raw_path),
            }
            click.echo(
                f"parse-raw: {key} failed: {type(exc).__name__}: {exc} "
                f"(raw {raw_path})",
                err=True,
            )
            continue
        response_text = raw_path.read_text(encoding="utf-8")
        raw_sha = hashlib.sha256(response_text.encode("utf-8")).hexdigest()
        try:
            result = align_stage.parse_raw_result(
                key,
                response_text,
                {key: sl},
                stream,
                config,
                write_conversation=False,
            )
        except Exception as exc:  # noqa: BLE001 - persist others, report this one
            failed += 1
            failed_folios.append(key)
            failures[key] = {
                "kind": "parse_error",
                "type": type(exc).__name__,
                "message": str(exc),
                "raw": str(raw_path),
                "raw_sha256": raw_sha,
                "conversation": str(conv_path),
            }
            click.echo(
                f"parse-raw: {key} failed: {type(exc).__name__}: {exc} "
                f"(raw {raw_path}, conversation {conv_path})",
                err=True,
            )
            continue
        contributor = _current_contributor()
        append_run(
            config.paths.audit,
            key,
            PipelineRun(
                stage=RunStage.PARSE_RAW,
                model=config.ai.model,
                temperature=config.ai.temperature,
                prompt_version=align_stage.PROMPT_VERSION,
                repo_hash=_repo_hash(),
                contributor_name=(contributor or {}).get("name"),
                contributor_email=(contributor or {}).get("email"),
                result_summary={
                    "method": result.alignment_method.value,
                    "atoms": sl.atom_end - sl.atom_start + 1,
                    "range": f"{sl.start_ref} – {sl.stop_ref}",
                    "raw": str(raw_path),
                    "raw_sha256": raw_sha,
                    "ai": align_stage.ai_snapshot(config),
                },
            ),
        )
        done += 1
        succeeded.append(key)
        click.echo(
            f"parse-raw: {key} -> {config.paths.alignments / f'{key}.json'}"
        )
    summary_ts = align_stage.batch_timestamp()
    summary_path = config.paths.alignments / "parse-raw" / f"{summary_ts}.json"
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(
        json.dumps(
            {
                "timestamp": summary_ts,
                "folios_attempted": folios,
                "done": done,
                "failed": failed,
                "succeeded": succeeded,
                "failed_folios": failed_folios,
                "failures": failures,
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    click.echo(
        f"parse-raw: parsed {done}/{len(folios)} folios ({failed} failed)"
        + (f": {', '.join(failed_folios)}" if failed_folios else "")
        + f" (summary {summary_path})"
    )


@cli.command()
@click.option("--folio", help="Validate a single folio. Omit for all.")
@click.pass_obj
def validate(config: Config, folio: str | None) -> None:
    """Run cross-checks on alignment records."""
    folios = [folio] if folio else _alignment_folios(config)
    for page in folios:
        _seed, _stream, sl, record = _load_pipeline(config, page)
        result = validate_stage.validate_folio(sl, record, _stream)
        append_run(
            config.paths.audit,
            page,
            PipelineRun(
                stage=RunStage.VALIDATE,
                checks=result.checks,
                result_summary={"passed": result.passed, "status": result.status},
            ),
            status=FolioStatus.ALIGNED if result.passed else None,
        )
        click.echo(f"validate: {page} {result.status} {result.checks}")


@cli.command()
@click.option("--folio", help="Generate TEI for a single folio. Omit for all.")
@click.pass_obj
def generate_tei(config: Config, folio: str | None) -> None:
    """Generate per-folio TEI XML from alignment records."""
    folios = [folio] if folio else _alignment_folios(config)
    contributor = _current_contributor()
    for page in folios:
        _seed, _stream, sl, record = _load_pipeline(config, page)
        trail = append_run(
            config.paths.audit,
            page,
            PipelineRun(
                stage=RunStage.GENERATE_TEI,
                repo_hash=_repo_hash(),
                contributor_name=(contributor or {}).get("name"),
                contributor_email=(contributor or {}).get("email"),
                result_summary={
                    "folio": page,
                    "range": f"{sl.start_ref} – {sl.stop_ref}",
                },
            ),
        )
        repo = _repo_hash()
        generate_ts = trail.runs[-1].timestamp if trail.runs else None
        edition = _stream.uxlc_edition
        xml = tei_stage.render_folio_tei(
            folio=page,
            verse_range=f"{sl.start_ref} – {sl.stop_ref}",
            record=record,
            page_milestones=[{"folio": page}],
            changes=tei_stage.changes_from_audit(trail.runs),
            contributors=tei_stage.contributors_from_audit(trail.runs),
            pipeline_version=config.project_version,
            repo_hash=repo,
            generated_when=generate_ts.isoformat() if generate_ts else None,
            source_image=tei_stage.source_image_from_audit(trail.runs),
            uxlc_edition=asdict(edition) if edition else None,
        )
        dest = config.paths.output / f"{page}.xml"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(xml)
        click.echo(f"generate-tei: {page} -> {dest}")


@cli.command()
@click.pass_obj
def build_index(config: Config) -> None:
    """Build index.xml from all generated TEI files."""
    dest = config.paths.output / "index.xml"
    dest.parent.mkdir(parents=True, exist_ok=True)
    generated = [p for p in config.paths.output.glob("*.xml") if p.stem != "index"]
    dest.write_text(index_stage.build_index(config.paths.output))
    update_pipeline_provenance(
        config.paths.provenance,
        config.project_version,
        index=IndexProvenance(path=str(dest), entries=len(generated)),
    )
    click.echo(f"build-index: {len(generated)} entries -> {dest}")

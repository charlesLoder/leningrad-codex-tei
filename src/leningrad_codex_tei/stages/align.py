"""align-folio stage: resolve a seed record to an atom range, then align it.

The aligner asks a vision model to map the folio's Hebrew text onto the
columns and lines visible in the folio image, then assembles the model's
placements into the alignment record consumed by the downstream stages.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
import warnings
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

from google.genai import Client, errors, types
from lxml import etree

from leningrad_codex_tei.config import Config
from leningrad_codex_tei.schemas import (
    AlignmentMethod,
    AlignmentRecord,
    ColumnRecord,
    LineRecord,
    SectionMilestone,
    VerseMilestone,
    Word,
    WordStream,
)


@dataclass
class ModelResponse:
    """Serializable snapshot of a model's response to a request.

    Carries the rendered text plus the lower-level detail we want to keep for
    the audit trail: the usage metadata (token counts) and the raw parts
    (executable code, thought traces, etc.) returned alongside the text.
    """

    text: str
    usage_metadata: dict
    parts: list[dict]

    @classmethod
    def from_generate_response(cls, response) -> "ModelResponse":
        """Build a snapshot from a google-genai GenerateContentResponse."""
        usage = response.usage_metadata
        usage_meta = usage.model_dump(exclude_none=True) if usage is not None else {}
        try:
            parts = [p.model_dump(exclude_none=True) for p in response.parts]
        except Exception:  # noqa: BLE001 - parts access is best-effort
            parts = []
        return cls(
            text=response.text or "",
            usage_metadata=usage_meta,
            parts=parts,
        )


@dataclass
class ChatResult:
    """A model exchange plus the full chat history that produced it.

    The history is the authoritative multi-turn record of a request: the user
    turn (image + prompt) and the model turn, as returned by
    ``chat.get_history()``. It is what we persist so a conversation can be
    replayed or audited against the exact prompts that ran.
    """

    response: ModelResponse
    history: list[dict]


ALIGN_PROMPT = """Map the <TEXT> onto the columns and lines of the image according to the TEI XML schema.

This folio is {folio}, the {side} of the leaf, and contains {columns} column(s) of Hebrew text. The text contained on this folio is {range}.

## Example Output

```xml
<cb n="1" />
<lb n="1" />
בְּרֵאשִׁית בָּרָא אֱלֹהִים
<lb n="2" />
אֵת הַשָּׁמַיִם וְאֵת הָאָרֶץ׃
```

## Goal

Focus on getting the start and end of the columns correct, and then just judge according to the last word in each line in each column,

You do NOT need a high fidelity understanding of the text on the page since you have it already, just make sure the words align.

## Instructions

- Copy the words from <TEXT> into the lines exactly as written: do not add, remove, split or join words.
- It is possible that some words at the beginning or end of the text may not appear on the folio; that's ok
- Do not output verse numbers, chapter markers or pe/samekh markers.
- Do not consider the meaning of the text, just the visual placement of the words on the folio.

## Response

Return ONLY the TEI XML, with no commentary and no markdown fences.

<TEXT>
{text}
</TEXT>"""

PROMPT_VERSION = hashlib.sha256(ALIGN_PROMPT.encode("utf-8")).hexdigest()

ALIGN_PROMPT_PATH = Path(__file__).resolve()


def ensure_align_prompt_clean() -> None:
    from leningrad_codex_tei.util.git import require_file_clean

    require_file_clean(ALIGN_PROMPT_PATH)


POETRY_BOOKS = {"Psalms", "Proverbs", "Job"}

RETRYABLE_CODES = {408, 429, 500, 502, 503, 504}


@dataclass
class SeedSlice:
    folio: str
    book: str
    start_ref: str
    stop_ref: str
    record: dict
    atom_start: int
    atom_end: int


def folio_side_for(folio: str) -> str:
    """Page side from the trailing letter of the folio id (A=recto, B=verso)."""
    return "verso" if folio.endswith("B") else "recto"


def column_count_for(book: str) -> int:
    """Best guess at the folio's column scheme for a book (a prompt hint only)."""
    return 2 if book in POETRY_BOOKS else 3


def _find_record(seed: dict, folio: str) -> dict:
    body = seed.get("body", []) if isinstance(seed, dict) else []
    for rec in body:
        if rec.get("page") == folio:
            return rec
    raise ValueError(f"no seed record for folio {folio}")


def _resolve(
    book_words: list, chapter: int | None, verse: int | None, part, stop: bool
):
    """Find the global atom for a (chapter, verse, part-of-verse) anchor."""
    cands = [w for w in book_words if w.chapter == chapter and w.verse == (verse or -1)]
    if not cands:
        raise ValueError(f"no words for anchor Genesis-ish {chapter}:{verse}")
    if part is None:
        return cands[-1] if stop else cands[0]
    hit = next((w for w in cands if w.word_index == int(part)), None)
    if hit is None:
        raise ValueError(f"no word at part {part} of {chapter}:{verse}")
    return hit


def compute_seed_slice(seed: dict, folio: str, word_stream: WordStream) -> SeedSlice:
    """Translate a seed record into an inclusive global atom range."""
    rec = _find_record(seed, folio)
    book = rec.get("bkid")
    if not book:
        raise ValueError(f"seed record for {folio} has no bkid")
    book_words = [w for w in word_stream.words if w.book == book]

    start = _resolve(
        book_words, rec.get("startc"), rec.get("startv"), rec.get("startp"), stop=False
    )
    stop = _resolve(
        book_words, rec.get("stopc"), rec.get("stopv"), rec.get("stopp"), stop=True
    )
    if stop.atom < start.atom:
        raise ValueError(f"seed range for {folio} is inverted")

    def _ref(w) -> str:
        return f"{w.book} {w.chapter}:{w.verse}"

    return SeedSlice(
        folio=folio,
        book=book,
        start_ref=_ref(start),
        stop_ref=_ref(stop),
        record=rec,
        atom_start=start.atom,
        atom_end=stop.atom,
    )


def _text_block(words: list[Word]) -> str:
    """Join slice words into the <TEXT> block as plain running text.

    Verses and section markers are not annotated: the verse boundaries and
    ke(pe)/samekh placements are derived downstream from UXLC, so the model
    does not need to echo them back as markup.
    """
    return " ".join(w.text for w in words)


def _build_prompt(sl: SeedSlice, word_stream: WordStream) -> str:
    slice_words = word_stream.words[sl.atom_start - 1 : sl.atom_end]
    return ALIGN_PROMPT.format(
        folio=sl.folio,
        side=folio_side_for(sl.folio),
        columns=column_count_for(sl.book),
        range=f"{sl.start_ref} – {sl.stop_ref}",
        text=_text_block(slice_words),
    )


def _model_client(config: Config) -> Client:
    return Client(http_options=types.HttpOptions(timeout=config.ai.timeout_ms))


def _el_local(el: etree._Element) -> str:
    tag = el.tag
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


PASEQ = "\u05c0"


def _is_marker_token(token: str) -> bool:
    """Ignore tokens the model may echo from <TEXT> but that are not words."""
    return (
        token.isdigit()
        or token in {"פ", "ס", "׆"}
        or (token.startswith("׃") and token[1:].isdigit())
    )


def _parse_epilog_xml(raw_text: str) -> list[tuple[int, int, int]]:
    """Parse the model's TEI XML into per-line word counts.

    Returns a list of ``(column, line, word_count)`` in document order.
    Milestones (chapter/verse/section) and echoed <TEXT> metadata (verse
    numbers, chapter markers, pe/samekh) are ignored when counting words.
    """
    text = raw_text.strip()
    text = re.sub(r"^<\?xml[^>]*\?>\s*", "", text)
    text = re.sub(r"^```(?:xml)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text).strip()

    root = etree.fromstring(f"<e>{text}</e>")

    col: int | None = None
    line: int | None = None
    buf: list[str] = []
    lines: list[tuple[int, int, int]] = []

    def add(segment: str | None) -> None:
        for token in (segment or "").split():
            if token == PASEQ and buf:
                buf[-1] += " " + token
                continue
            if not _is_marker_token(token):
                buf.append(token)

    def flush() -> None:
        if not buf:
            return
        if col is None or line is None:
            raise ValueError("text found outside a column and line")
        lines.append((col, line, len(buf)))
        buf.clear()

    for el in root.iter():
        tag = _el_local(el)
        if tag == "cb":
            flush()
            col = int(el.get("n") or 0)
            line = None
            add(el.tail)
        elif tag == "lb":
            flush()
            line = int(el.get("n") or 0)
            add(el.text)
            add(el.tail)
        else:
            add(el.text)
            add(el.tail)
    flush()

    if not lines:
        raise ValueError("no lines found in model response")
    for col_no, line_no, count in lines:
        if count < 1:
            raise ValueError(f"empty line {col_no}:{line_no}")
    return lines


def _place_words(
    line_counts: list[tuple[int, int, int]], atom_start: int
) -> list[tuple[int, int, int]]:
    """Assign source atoms to (column, line) from per-line word counts."""
    placements: list[tuple[int, int, int]] = []
    atom = atom_start
    for col_no, line_no, count in line_counts:
        for _ in range(count):
            placements.append((atom, col_no, line_no))
            atom += 1
    return placements


def ai_snapshot(config: Config) -> dict:
    """Effective ai options, stored alongside results for auditability."""
    return {
        "model": config.ai.model,
        "temperature": config.ai.temperature,
        "inference": config.ai.inference,
        "max_retries": config.ai.max_retries,
        "code_execution": config.ai.code_execution,
        "base_delay": config.ai.base_delay,
        "timeout_ms": config.ai.timeout_ms,
        "fallback_to_standard": config.ai.fallback_to_standard,
        "image_transport": config.ai.image_transport,
        "thinking_level": config.ai.thinking_level,
    }


def service_tier_for(config: Config) -> str | None:
    """Map the inference mode to an API service tier (None = API default)."""
    if config.ai.inference == "flex":
        return "flex"
    return None


def check_image_transport(config: Config) -> None:
    """Enforce/warn on the image_transport + inference combination."""
    if config.ai.inference == "batch" and config.ai.image_transport != "encode":
        raise ValueError(
            'ai.image_transport must be "encode" when ai.inference is "batch"'
        )
    if config.ai.inference in ("standard", "flex") and (
        config.ai.image_transport == "encode"
    ):
        warnings.warn(
            'ai.image_transport is "encode"; "upload" is preferred for '
            f'"{config.ai.inference}" inference',
            UserWarning,
            stacklevel=3,
        )


def _thinking_level_for(config: Config) -> types.ThinkingLevel:
    return types.ThinkingLevel(config.ai.thinking_level)


def _request_config(
    config: Config, service_tier: str | None
) -> types.GenerateContentConfig:
    cfg = types.GenerateContentConfig(
        temperature=config.ai.temperature,
        thinking_config=types.ThinkingConfig(
            thinking_level=_thinking_level_for(config)
        ),
        tools=(
            [types.Tool(code_execution=types.ToolCodeExecution())]
            if config.ai.code_execution
            else []
        ),
    )
    if service_tier:
        cfg.service_tier = types.ServiceTier(service_tier)
    return cfg


def _is_retryable(exc: errors.APIError) -> bool:
    return getattr(exc, "code", None) in RETRYABLE_CODES


def _generate_with_flex(
    client: Client | None, config: Config, message: list
) -> ChatResult:
    """Call the model via a Chat session with exponential backoff.

    We use ``Chat.send_message`` rather than ``Models.generate_content`` so the
    conversation is a proper multi-turn session (which also silences the AFC
    warning that ``generate_content`` emits for function calling). A fresh Chat
    is created per attempt so a failed/retried attempt never duplicates turns in
    the stored history.

    Flex is best-effort and sheds load with 503s, so we retry transient
    failures (429/408/5xx) with exponential backoff, optionally falling back to
    the standard tier on the final attempt.
    """
    if client is None:
        raise ValueError("a model client is required to generate content")
    max_attempts = max(1, config.ai.max_retries)
    base_delay = max(config.ai.base_delay, 0.0)
    last_error: Exception | None = None

    for attempt in range(max_attempts):
        fallback = config.ai.fallback_to_standard and attempt == max_attempts - 1
        tier = None if fallback else service_tier_for(config)
        cfg = _request_config(config, tier)
        try:
            chat = client.chats.create(model=config.ai.model, config=cfg)
            response = chat.send_message(message=message, config=cfg)
            if not response.text:
                raise ValueError("model returned an empty response")
            history = [c.model_dump(exclude_none=True) for c in chat.get_history()]
            return ChatResult(
                response=ModelResponse.from_generate_response(response),
                history=history,
            )
        except errors.APIError as exc:
            last_error = exc
            if not _is_retryable(exc):
                raise
        except Exception as exc:  # noqa: BLE001 - transport failures retry like 5xx
            last_error = exc

        if attempt < max_attempts - 1:
            time.sleep(base_delay * (2**attempt))

    raise RuntimeError(
        f"model request failed after {max_attempts} attempts: {last_error}"
    ) from last_error


def _request_alignment(
    sl: SeedSlice, word_stream: WordStream, config: Config, prompt: str
) -> ChatResult:
    image_path = config.paths.images / config.images.naming.format(folio=sl.folio)
    if not image_path.exists():
        raise FileNotFoundError(f"image not found: {image_path}")
    check_image_transport(config)

    if config.ai.image_transport == "encode":
        image_part = _image_part_from_bytes(image_path)
        client: Client | None = None
    else:
        client = _model_client(config)
        image_part = _image_part_from_upload(client, image_path)

    return _generate_with_flex(
        client,
        config,
        message=[image_part, prompt],
    )


def _image_part_from_bytes(image_path: Path) -> types.Part:
    """Send the image inline, base64-encoded in the request body."""
    mime_type = _mime_for_suffix(image_path.suffix)
    return types.Part.from_bytes(data=image_path.read_bytes(), mime_type=mime_type)


def _image_part_from_upload(client: Client, image_path: Path) -> types.Part:
    """Send the image via the File API, uploading it first if not already present."""
    image_uri, mime_type = _resolve_image(client, image_path)
    return types.Part.from_uri(file_uri=image_uri, mime_type=mime_type)


def _mime_for_suffix(suffix: str) -> str:
    return {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".tif": "image/tiff",
        ".tiff": "image/tiff",
    }.get(suffix.lower(), "image/jpeg")


def _resolve_image(client: Client, image_path: Path) -> tuple[str, str]:
    """Return (file_uri, mime_type) for a local image, uploading it to the File
    API if not already present. The File API needs an HTTPS/gURI referencing the
    uploaded file, never a local filesystem path, so local images must be
    uploaded before they can be passed to the model. Uploads are cached by the
    image stem so repeated runs reuse the already-uploaded file.
    """
    mime_type = _mime_for_suffix(image_path.suffix)
    name = image_path.stem.replace("_", "-").lower()
    try:
        file = client.files.get(name=name)
    except Exception:
        file = client.files.upload(
            file=image_path,
            config=types.UploadFileConfig(
                mime_type=mime_type,
                name=name,
                display_name=image_path.stem,
            ),
        )
    if not file.uri:
        raise RuntimeError(f"image upload produced no file URI for {image_path}")
    return file.uri, mime_type


def align_folio_ai(
    sl: SeedSlice,
    word_stream: WordStream,
    config: Config,
    request=None,
) -> AlignmentRecord:
    """Ask a vision model to map the slice's words onto columns and lines.

    The model returns TEI XML carrying each word inside ``<cb>/<lb>``
    lines. We count the words per line, assign the source atoms sequentially,
    and assemble the alignment record.
    """
    request = request or _request_alignment
    slice_words = word_stream.words[sl.atom_start - 1 : sl.atom_end]
    prompt = _build_prompt(sl, word_stream)

    record: AlignmentRecord | None = None
    last_error: Exception | None = None
    usage_metadata: dict | None = None
    parts: list[dict] | None = None
    history: list[dict] | None = None
    for _ in range(max(1, config.ai.max_retries)):
        try:
            result = request(sl, word_stream, config, prompt)
            if isinstance(result, ChatResult):
                text, usage_metadata, parts, history = (
                    result.response.text,
                    result.response.usage_metadata,
                    result.response.parts,
                    result.history,
                )
            elif isinstance(result, ModelResponse):
                text, usage_metadata, parts = (
                    result.text,
                    result.usage_metadata,
                    result.parts,
                )
            else:
                text = result
            line_counts = _parse_epilog_xml(text)
            placement = _place_words(line_counts, sl.atom_start)
            record = build_alignment_record(
                sl, slice_words, placement, model_response=text
            )
            break
        except Exception as exc:  # noqa: BLE001 - retry on any model failure
            last_error = exc
    if record is None:
        raise RuntimeError(f"model alignment failed after retries: {last_error}")

    image_path = config.paths.images / config.images.naming.format(folio=sl.folio)
    conversation = build_conversation(
        folio=sl.folio,
        prompt=prompt,
        image_uri=str(image_path),
        model=config.ai.model,
        prompt_version=PROMPT_VERSION,
        inference=config.ai.inference,
        response_text=record.model_response,
        usage_metadata=usage_metadata,
        parts=parts,
        history=history,
        ai=ai_snapshot(config),
    )
    save_conversation(conversation, config.paths.alignments, sl.folio)
    return record


def build_alignment_record(
    sl: SeedSlice,
    slice_words: list[Word],
    placements,
    model_response: str | None = None,
) -> AlignmentRecord:
    by_pos = {p[0]: (p[1], p[2]) for p in placements}
    lines: dict[tuple[int, int], list[Word]] = {}
    for w in slice_words:
        lines.setdefault(by_pos[w.atom], []).append(w)

    columns: list[ColumnRecord] = []
    for (col_no, line_no), atoms in sorted(
        lines.items(), key=lambda kv: (kv[0][0], kv[0][1])
    ):
        if not columns or columns[-1].column_number != col_no:
            columns.append(ColumnRecord(column_number=col_no, lines=[]))
        columns[-1].lines.append(
            LineRecord(
                line_number=line_no,
                atom_start=atoms[0].atom,
                atom_end=atoms[-1].atom,
                text_sample=atoms[0].text[:20],
                atoms=atoms,
            )
        )

    location: dict[int, tuple[int, int]] = {}
    for col in columns:
        for line in col.lines:
            for atom in line.atoms:
                location[atom.atom] = (col.column_number, line.line_number)

    verse_milestones: list[VerseMilestone] = []
    section_milestones: list[SectionMilestone] = []
    prev_vkey: tuple[int, int] | None = None
    verse_atoms: dict[tuple[int, int], list[Word]] = {}
    for w in slice_words:
        verse_atoms.setdefault((w.chapter, w.verse), []).append(w)
        vkey = (w.chapter, w.verse)
        if vkey != prev_vkey:
            col_no, line_no = location[w.atom]
            verse_milestones.append(
                VerseMilestone(
                    verse=f"{w.book} {vkey[0]}:{vkey[1]}",
                    column=col_no,
                    line=line_no,
                    atom=w.atom,
                )
            )
            prev_vkey = vkey

    for vkey, vwords in verse_atoms.items():
        last = vwords[-1]
        if not (last.has_pe or last.has_samekh):
            continue
        section = "pe" if last.has_pe else "samekh"
        col_no, line_no = location[last.atom]
        section_milestones.append(
            SectionMilestone(
                subtype=section,
                column=col_no,
                line=line_no,
                atom=last.atom,
                verse=f"{last.book} {vkey[0]}:{vkey[1]}",
            )
        )

    return AlignmentRecord(
        folio=sl.folio,
        folio_side=folio_side_for(sl.folio),
        seed_record=sl.record,
        columns=columns,
        verse_milestones=verse_milestones,
        section_milestones=section_milestones,
        model_response=model_response,
        alignment_method=AlignmentMethod.AI_VISION,
        aligned_at=datetime.now(timezone.utc),
    )


def save_alignment(record: AlignmentRecord, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(asdict(record), indent=2, default=str))
    if record.model_response:
        raw = path.parent / "raw" / f"{path.stem}.xml"
        raw.parent.mkdir(parents=True, exist_ok=True)
        raw.write_text(record.model_response)


def load_alignment(path: Path) -> AlignmentRecord:
    data = json.loads(path.read_text())
    if "model_response" not in data:
        raw = path.parent / "raw" / f"{path.stem}.xml"
        if raw.exists():
            data["model_response"] = raw.read_text()
    columns = [
        ColumnRecord(
            column_number=c["column_number"],
            lines=[
                LineRecord(
                    line_number=l["line_number"],
                    atom_start=l["atom_start"],
                    atom_end=l["atom_end"],
                    text_sample=l.get("text_sample", ""),
                    atoms=[Word(**a) for a in l.get("atoms", [])],
                )
                for l in c.get("lines", [])
            ],
        )
        for c in data.get("columns", [])
    ]
    return AlignmentRecord(
        folio=data["folio"],
        folio_side=data["folio_side"],
        seed_record=data.get("seed_record", {}),
        columns=columns,
        verse_milestones=[
            VerseMilestone(**m) for m in data.get("verse_milestones", [])
        ],
        section_milestones=[
            SectionMilestone(**m) for m in data.get("section_milestones", [])
        ],
        model_response=data.get("model_response"),
        alignment_method=AlignmentMethod(
            data.get("alignment_method", AlignmentMethod.STUB.value)
        ),
        aligned_at=datetime.fromisoformat(data["aligned_at"])
        if data.get("aligned_at")
        else None,
        checks=data.get("checks"),
    )


def build_conversation(
    *,
    folio: str,
    prompt: str,
    image_uri: str,
    model: str,
    prompt_version: str,
    inference: str | None = None,
    service_tier: str | None = None,
    response_text: str | None,
    usage_metadata: dict | None = None,
    parts: list[dict] | None = None,
    history: list[dict] | None = None,
    ai: dict | None = None,
) -> dict:
    """Assemble the request/response exchange with a model into a JSON document.

    When ``history`` (the multi-turn record from ``chat.get_history()``) is
    available it is used as the authoritative ``messages``; otherwise the
    single user/model turn is reconstructed from the prompt, image, and
    response so the conversation stays self-describing.
    """
    mode = inference if inference is not None else service_tier
    return {
        "folio": folio,
        "model": model,
        "prompt_version": prompt_version,
        "inference": mode,
        "service_tier": mode,
        "image_uri": image_uri,
        "ai": ai or {},
        "messages": history
        or [
            {
                "role": "user",
                "parts": [{"image": image_uri}, {"text": prompt}],
            },
            {
                "role": "model",
                "parts": parts or [],
                "text": response_text,
            },
        ],
        "response": response_text,
        "usage_metadata": usage_metadata or {},
    }


def save_conversation(conversation: dict, base_dir: Path, folio: str) -> Path:
    """Persist a conversation as JSON under conversations/{folio}.json."""
    dest = base_dir / "conversations" / f"{folio}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(conversation, indent=2, ensure_ascii=False))
    return dest


def batch_timestamp(now: datetime | None = None) -> str:
    return (now or datetime.now(timezone.utc)).strftime("%Y%m%dT%H%M%S")


def _batch_image_b64(image_path: Path) -> tuple[str, str]:
    mime_type = _mime_for_suffix(image_path.suffix)
    return mime_type, base64.b64encode(image_path.read_bytes()).decode("ascii")


def build_batch_request_line(
    sl: SeedSlice, word_stream: WordStream, config: Config, prompt: str
) -> dict:
    """Build one JSONL line for the Batch API input file (encode-only)."""
    image_path = config.paths.images / config.images.naming.format(folio=sl.folio)
    if not image_path.exists():
        raise FileNotFoundError(f"image not found: {image_path}")
    mime_type, b64 = _batch_image_b64(image_path)
    request: dict = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {"inline_data": {"mime_type": mime_type, "data": b64}},
                    {"text": prompt},
                ],
            }
        ],
    }
    if config.ai.code_execution:
        request["tools"] = [{"code_execution": {}}]
    request["generation_config"] = {
        "thinking_config": {"thinking_level": config.ai.thinking_level}
    }
    return {"key": sl.folio, "request": request}


def build_batch_prompts(
    slices: list[SeedSlice], word_stream: WordStream
) -> dict[str, str]:
    return {sl.folio: _build_prompt(sl, word_stream) for sl in slices}


def submit_batch(
    slices: list[SeedSlice],
    word_stream: WordStream,
    config: Config,
    client: Client | None = None,
    now: datetime | None = None,
) -> dict:
    """Write the JSONL upload, create the batch job, persist its record."""
    check_image_transport(config)
    if config.ai.inference != "batch":
        raise ValueError('submit_batch requires ai.inference == "batch"')
    if not slices:
        raise ValueError("no folios selected for batch submission")
    own_client = client if client is not None else _model_client(config)
    ts = batch_timestamp(now)
    prompts = build_batch_prompts(slices, word_stream)

    job_dir = batch_job_dir(config.paths.alignments / "batch", ts)
    upload_path = job_dir / "upload.jsonl"
    upload_path.parent.mkdir(parents=True, exist_ok=True)
    with upload_path.open("w", encoding="utf-8") as fh:
        for sl in slices:
            fh.write(
                json.dumps(
                    build_batch_request_line(
                        sl, word_stream, config, prompts[sl.folio]
                    ),
                    ensure_ascii=False,
                )
                + "\n"
            )

    uploaded = own_client.files.upload(
        file=str(upload_path),
        config=types.UploadFileConfig(
            display_name=f"align-folio-{ts}", mime_type="jsonl"
        ),
    )
    src_name = uploaded.name or ""
    job = own_client.batches.create(
        model=config.ai.model,
        src=src_name,
        config={"display_name": f"align-folio-{ts}"},
    )
    record = {
        "job_name": job.name,
        "display_name": f"align-folio-{ts}",
        "timestamp": ts,
        "upload_path": str(upload_path),
        "upload_file": uploaded.name,
        "folios": [sl.folio for sl in slices],
        "prompts": prompts,
        "model": config.ai.model,
        "prompt_version": PROMPT_VERSION,
        "ai": ai_snapshot(config),
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    dest = job_dir / "submit.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(record, indent=2, ensure_ascii=False))
    return record


def batch_job_dir(base_dir: Path, batch_ts: str) -> Path:
    """Job directory for one batch submission: ``batch/{ts}/``."""
    return base_dir / batch_ts


def find_latest_batch_record(base_dir: Path) -> Path:
    cands = sorted(base_dir.glob("*/submit.json"))
    if not cands:
        raise FileNotFoundError(f"no batch records in {base_dir}")
    return cands[-1]


def resolve_batch_job_dir(
    base_dir: Path, selector: str | None
) -> tuple[Path, dict | None]:
    """Resolve a download-batch selector to its job directory and record."""
    if selector is None:
        record_path = find_latest_batch_record(base_dir)
        return record_path.parent, json.loads(record_path.read_text())
    sel_path = Path(selector)
    if selector.endswith(".json"):
        record_path = sel_path if sel_path.is_absolute() else base_dir / selector
        if not record_path.exists() and sel_path.exists():
            record_path = sel_path
        return record_path.parent, json.loads(record_path.read_text())
    candidate = base_dir / selector
    if candidate.is_dir() and (candidate / "submit.json").exists():
        record_path = candidate / "submit.json"
        return candidate, json.loads(record_path.read_text())
    if candidate.exists() and candidate.is_file():
        return candidate.parent, json.loads(candidate.read_text())
    for record_path in sorted(base_dir.glob("*/submit.json")):
        try:
            rec = json.loads(record_path.read_text())
        except Exception:  # noqa: BLE001 - skip unreadable records
            continue
        if rec.get("job_name") == selector:
            return record_path.parent, rec
    job_dir = base_dir / selector.replace("/", "-")
    return job_dir, None


def job_state_name(job) -> str:
    state = job.get("state", "") if isinstance(job, dict) else getattr(job, "state", "")
    name = getattr(state, "name", state)
    return str(name) if name is not None else ""


def write_poll_record(
    job_dir: Path,
    job,
    now: datetime | None = None,
) -> Path:
    now = now or datetime.now(timezone.utc)
    dest = job_dir / "polls" / f"{batch_timestamp(now)}.json"
    dest.parent.mkdir(parents=True, exist_ok=True)
    batch_ts = job_dir.name
    try:
        raw = job.model_dump(exclude_none=True, mode="json")
    except Exception:  # noqa: BLE001 - best-effort raw dump
        raw = {"repr": repr(job)}
    dest.write_text(
        json.dumps(
            {
                "job_name": job.get("name")
                if isinstance(job, dict)
                else getattr(job, "name", None),
                "batch_timestamp": batch_ts,
                "polled_at": now.isoformat(),
                "status": job_state_name(job),
                "response": raw,
            },
            indent=2,
            ensure_ascii=False,
            default=str,
        )
    )
    return dest


def batch_result_file_name(job) -> str | None:
    dest = job.get("dest") if isinstance(job, dict) else getattr(job, "dest", None)
    if dest is None:
        return None
    for attr in ("file_name", "fileName"):
        val = dest.get(attr) if isinstance(dest, dict) else getattr(dest, attr, None)
        if val:
            return str(val)
    return None


def save_raw_model_response(base_dir: Path, folio: str, text: str) -> Path:
    """Persist one folio's raw model text under alignments/raw/{folio}.xml."""
    dest = base_dir / "raw" / f"{folio}.xml"
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(text, encoding="utf-8")
    return dest


def materialize_batch_result(
    folio: str,
    text: str,
    slices: dict[str, SeedSlice],
    word_stream: WordStream,
    config: Config,
    prompt: str | None = None,
    job_name: str | None = None,
    prompt_version: str | None = None,
) -> AlignmentRecord:
    """Parse one batch result into an alignment record + conversation file."""
    version = prompt_version or PROMPT_VERSION
    try:
        sl = slices[folio]
        slice_words = word_stream.words[sl.atom_start - 1 : sl.atom_end]
        line_counts = _parse_epilog_xml(text)
        placements = _place_words(line_counts, sl.atom_start)
        record = build_alignment_record(
            sl, slice_words, placements, model_response=text
        )
        save_alignment(record, config.paths.alignments / f"{folio}.json")
    except Exception:
        try:
            save_raw_model_response(config.paths.alignments, folio, text)
        except Exception:  # noqa: BLE001 - best-effort failure artifact
            pass
        try:
            sl_opt = slices.get(folio) if isinstance(slices, dict) else None
            if sl_opt is not None:
                image_path = config.paths.images / config.images.naming.format(
                    folio=folio
                )
                conversation = build_conversation(
                    folio=folio,
                    prompt=prompt
                    if prompt is not None
                    else _build_prompt(sl_opt, word_stream),
                    image_uri=str(image_path),
                    model=config.ai.model,
                    prompt_version=version,
                    inference=config.ai.inference,
                    response_text=text,
                    ai={**ai_snapshot(config), "batch_job": job_name},
                )
                save_conversation(conversation, config.paths.alignments, folio)
        except Exception:  # noqa: BLE001 - best-effort failure artifact
            pass
        raise
    image_path = config.paths.images / config.images.naming.format(folio=folio)
    conversation = build_conversation(
        folio=folio,
        prompt=prompt if prompt is not None else _build_prompt(sl, word_stream),
        image_uri=str(image_path),
        model=config.ai.model,
        prompt_version=version,
        inference=config.ai.inference,
        response_text=text,
        ai={**ai_snapshot(config), "batch_job": job_name},
    )
    save_conversation(conversation, config.paths.alignments, folio)
    return record


def text_from_batch_response(response) -> str:
    """Extract generated text from one batch result-line response object."""
    if isinstance(response, dict):
        cands = response.get("candidates", [])
        if cands:
            parts = cands[0].get("content", {}).get("parts", [])
            texts = [p.get("text", "") for p in parts if p.get("text")]
            if texts:
                return "".join(texts)
        return response.get("text", "") or ""
    candidates = getattr(response, "candidates", None) or []
    chunks: list[str] = []
    for cand in candidates:
        content = getattr(cand, "content", None)
        for part in getattr(content, "parts", None) or []:
            t = getattr(part, "text", None)
            if t:
                chunks.append(t)
    if chunks:
        return "".join(chunks)
    return getattr(response, "text", "") or ""

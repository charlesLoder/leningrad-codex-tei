"""Data contracts between pipeline stages."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path

# --- Word stream (output of build-word-stream) ---


@dataclass
class Word:
    atom: int
    text: str
    book: str
    chapter: int
    verse: int
    word_index: int
    has_pe: bool = False
    has_samekh: bool = False


@dataclass
class WordStream:
    source: str
    generated_at: datetime
    words: list[Word]


# --- Alignment record (output of align-folio) ---


@dataclass
class LineRecord:
    line_number: int
    atom_start: int
    atom_end: int
    text_sample: str = ""
    atoms: list[Word] = field(default_factory=list)


@dataclass
class ColumnRecord:
    column_number: int
    lines: list[LineRecord] = field(default_factory=list)


@dataclass
class VerseMilestone:
    verse: str
    column: int
    line: int
    atom: int


@dataclass
class SectionMilestone:
    subtype: str  # "pe" | "samekh"
    column: int
    line: int
    atom: int
    verse: str


class AlignmentMethod(str, Enum):
    STUB = "stub"
    AI_VISION = "ai-vision"


@dataclass
class AlignmentRecord:
    folio: str
    folio_side: str  # "recto" or "verso"
    seed_record: dict
    columns: list[ColumnRecord] = field(default_factory=list)
    verse_milestones: list[VerseMilestone] = field(default_factory=list)
    section_milestones: list[SectionMilestone] = field(default_factory=list)
    model_response: str | None = None
    alignment_method: AlignmentMethod = AlignmentMethod.STUB
    aligned_at: datetime | None = None
    checks: dict | None = None


# --- Audit trail (output of various stages) ---


class RunStage(str, Enum):
    VENDOR_SEED = "vendor-seed"
    DOWNLOAD_UXLC = "download-uxlc"
    DOWNLOAD_IMAGES = "download-images"
    BUILD_WORD_STREAM = "build-word-stream"
    ALIGN_FOLIO = "align-folio"
    DOWNLOAD_BATCH = "download-batch"
    VALIDATE = "validate"
    GENERATE_TEI = "generate-tei"
    BUILD_INDEX = "build-index"


@dataclass
class PipelineRun:
    stage: RunStage
    model: str | None = None
    temperature: float | None = None
    prompt_version: str | None = None
    repo_hash: str | None = None
    input_image_sha256: str | None = None
    checks: dict | None = None
    result_summary: dict | None = None
    timestamp: datetime | None = None


class FolioStatus(str, Enum):
    PENDING = "pending"
    ALIGNED = "aligned"
    VERIFIED = "verified"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


@dataclass
class AuditTrail:
    folio: str
    runs: list[PipelineRun] = field(default_factory=list)
    status: FolioStatus = FolioStatus.PENDING
    created_at: datetime = field(default_factory=_utcnow)
    updated_at: datetime = field(default_factory=_utcnow)


# --- Pipeline provenance (corpus-level inputs, recorded once) ---


@dataclass
class SeedProvenance:
    url: str
    commit: str
    snapshot_commit: str | None
    sha256: str
    records: int
    path: str


@dataclass
class UxlcProvenance:
    url: str
    path: str
    files: int
    zip_sha256: str


@dataclass
class WordStreamProvenance:
    source: str
    sha256: str
    words: int
    path: str


@dataclass
class IndexProvenance:
    path: str
    entries: int


@dataclass
class PipelineProvenance:
    project_version: str | None = None
    seed: SeedProvenance | None = None
    uxlc: UxlcProvenance | None = None
    word_stream: WordStreamProvenance | None = None
    index: IndexProvenance | None = None
    updated_at: datetime = field(default_factory=_utcnow)

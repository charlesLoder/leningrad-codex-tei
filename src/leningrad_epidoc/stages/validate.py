"""validate stage: gate an alignment against its seed slice."""

from __future__ import annotations

from dataclasses import dataclass

from leningrad_epidoc.schemas import AlignmentRecord, WordStream
from leningrad_epidoc.stages.align import SeedSlice


@dataclass
class ValidationResult:
    folio: str
    checks: dict[str, bool]
    passed: bool
    status: str  # "aligned" | "failed"


def validate_folio(sl: SeedSlice, alignment: AlignmentRecord, word_stream: WordStream) -> ValidationResult:
    """Cross-check the alignment against the seed slice. Pure; no side effects."""
    atoms = [a for col in alignment.columns for line in col.lines for a in line.atoms]
    span = sl.atom_end - sl.atom_start + 1

    checks = {
        "word_count": len(atoms) == span,
        "atoms_sequential": all(a.atom == sl.atom_start + i for i, a in enumerate(atoms)),
    }
    passed = all(checks.values())
    return ValidationResult(
        folio=alignment.folio,
        checks=checks,
        passed=passed,
        status="aligned" if passed else "failed",
    )
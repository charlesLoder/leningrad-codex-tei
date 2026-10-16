"""validate stage: gate an alignment against its seed slice."""

from __future__ import annotations

from dataclasses import dataclass

from leningrad_codex_tei.schemas import AlignmentRecord, WordStream
from leningrad_codex_tei.stages.align import SeedSlice


@dataclass
class ValidationResult:
    folio: str
    checks: dict[str, bool]
    passed: bool
    status: str  # "aligned" | "failed"


def validate_folio(
    sl: SeedSlice, alignment: AlignmentRecord, word_stream: WordStream
) -> ValidationResult:
    """Cross-check the alignment against the seed slice. Pure; no side effects."""
    atoms = [a for col in alignment.columns for line in col.lines for a in line.atoms]
    span = sl.atom_end - sl.atom_start + 1

    by_atom = {w.atom: w for w in word_stream.words}
    texts_match = True
    for a in atoms:
        expected = by_atom.get(a.atom)
        if expected is None or expected.text != a.text:
            texts_match = False
            break

    page_atoms = {a.atom for a in atoms}
    sections_placed = True
    for sm in alignment.section_milestones:
        if sm.atom not in page_atoms:
            sections_placed = False
            break
        src = by_atom.get(sm.atom)
        if src is None:
            sections_placed = False
            break
        want = {
            "pe": src.has_pe,
            "samekh": src.has_samekh,
            "inverted-nun": src.has_inverted_nun,
        }.get(sm.subtype, False)
        if not want:
            sections_placed = False
            break

    verses_start = True
    for vm in alignment.verse_milestones:
        if vm.atom not in page_atoms:
            verses_start = False
            break
        src = by_atom.get(vm.atom)
        if src is None or src.word_index != 1:
            # verse milestone must sit on first atom of its verse
            # word_index 1 marks verse start in the UXLC stream
            verses_start = False
            break

    checks = {
        "word_count": len(atoms) == span,
        "atoms_sequential": all(
            a.atom == sl.atom_start + i for i, a in enumerate(atoms)
        ),
        "text_match": texts_match,
        "sections_placed": sections_placed,
        "verses_start": verses_start,
    }
    passed = all(checks.values())
    return ValidationResult(
        folio=alignment.folio,
        checks=checks,
        passed=passed,
        status="aligned" if passed else "failed",
    )


def find_meeting_gaps(
    folios_in_order: list[str],
    spans: dict[str, tuple[int, int]],
) -> list[dict]:
    """List gaps between consecutive pages.

    Each page must start at prev end + 1.
    Returns one dict per gap with prev, next, expected, found.
    """
    gaps: list[dict] = []
    prev_end: int | None = None
    prev_folio: str | None = None
    for folio in folios_in_order:
        start, end = spans[folio]
        if prev_end is not None and start != prev_end + 1:
            gaps.append(
                {
                    "prev": prev_folio,
                    "next": folio,
                    "expected": prev_end + 1,
                    "found": start,
                }
            )
        prev_end = end
        prev_folio = folio
    return gaps

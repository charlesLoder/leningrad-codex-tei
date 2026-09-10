"""Tests for the validate stage: cross-checks against the seed slice."""

from __future__ import annotations

from leningrad_epidoc.schemas import AlignmentRecord
from leningrad_epidoc.stages.align import build_alignment_record
from leningrad_epidoc.stages.validate import ValidationResult, validate_folio


def _document_order_placements(atom_start: int, atom_end: int) -> list[tuple[int, int, int]]:
    col = 1
    line = 1
    placements: list[tuple[int, int, int]] = []
    for i in range(atom_start, atom_end + 1):
        placements.append((i, col, line))
        if (i - atom_start) % 3 == 2:
            line += 1
            if line > 9:
                line = 1
                col += 1
    return placements


def _valid_alignment(seed_slice, word_stream) -> AlignmentRecord:
    slice_words = word_stream.words[seed_slice.atom_start - 1 : seed_slice.atom_end]
    placements = _document_order_placements(
        seed_slice.atom_start, seed_slice.atom_end
    )
    return build_alignment_record(seed_slice, slice_words, placements)


def test_valid_alignment_passes_all_checks(seed_slice, word_stream) -> None:
    alignment = _valid_alignment(seed_slice, word_stream)
    result = validate_folio(seed_slice, alignment, word_stream)
    assert isinstance(result, ValidationResult)
    assert result.passed is True
    assert result.status == "aligned"
    assert result.checks["word_count"] is True
    assert result.checks["atoms_sequential"] is True


def test_word_count_mismatch_fails(seed_slice, word_stream) -> None:
    drop = AlignmentRecord(folio="001B", folio_side="verso", seed_record={}, columns=[])
    result = validate_folio(seed_slice, drop, word_stream)
    assert result.passed is False
    assert result.status == "failed"
    assert result.checks["word_count"] is False
    assert result.checks["atoms_sequential"] is True


def test_gapped_atoms_fail(seed_slice, word_stream) -> None:
    gapped = _valid_alignment(seed_slice, word_stream)
    gapped.columns[0].lines[0].atoms = gapped.columns[0].lines[0].atoms[1:]
    result = validate_folio(seed_slice, gapped, word_stream)
    assert result.passed is False
    assert result.checks["atoms_sequential"] is False


def test_atoms_outside_seed_range_fail(seed_slice, word_stream) -> None:
    alignment = _valid_alignment(seed_slice, word_stream)
    alignment.columns[0].lines[0].atoms[0].atom = 999
    result = validate_folio(seed_slice, alignment, word_stream)
    assert result.passed is False
    assert result.checks["atoms_sequential"] is False
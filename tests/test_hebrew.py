"""Tests for Node-backed Hebrew sequencing."""

from __future__ import annotations

from leningrad_codex_tei.util.hebrew import sequence_text, sequence_texts

BET_SHEVA_DAGESH = "\u05d1\u05b0\u05bc\u05e8"
BET_DAGESH_SHEVA = "\u05d1\u05bc\u05b0\u05e8"


def test_sequence_reorders_dagesh_before_vowel() -> None:
    assert sequence_text(BET_SHEVA_DAGESH) == BET_DAGESH_SHEVA


def test_sequence_orders_full_word_consonant_dagesh_vowel_taam() -> None:
    raw = "\u05d1\u05b0\u05bc\u05e8\u05b5\u05d0\u05e9\u05b4\u05c1\u0596\u05d9\u05ea"
    fixed = "\u05d1\u05bc\u05b0\u05e8\u05b5\u05d0\u05e9\u05c1\u05b4\u0596\u05d9\u05ea"
    assert sequence_text(raw) == fixed


def test_sequence_is_idempotent() -> None:
    assert sequence_text(BET_DAGESH_SHEVA) == BET_DAGESH_SHEVA


def test_sequence_batch_preserves_length_and_order() -> None:
    texts = [BET_SHEVA_DAGESH, BET_DAGESH_SHEVA, ""]
    assert sequence_texts(texts) == [BET_DAGESH_SHEVA, BET_DAGESH_SHEVA, ""]


def test_sequence_empty_batch() -> None:
    assert sequence_texts([]) == []

"""Tests for the align-folio stage (seed-slice resolution + AI record building)."""

from __future__ import annotations

import json

import pytest
from google.genai import types

from leningrad_codex_tei.config import AiConfig
from leningrad_codex_tei.schemas import AlignmentMethod
from leningrad_codex_tei.stages.align import (
    ChatResult,
    ModelResponse,
    _generate_with_flex,
    _image_part_from_bytes,
    _image_part_from_upload,
    _mime_for_suffix,
    _parse_epilog_xml,
    _place_words,
    _request_alignment,
    _resolve_image,
    ai_snapshot,
    align_folio_ai,
    batch_job_dir,
    batch_result_file_name,
    build_alignment_record,
    build_batch_request_line,
    build_conversation,
    check_image_transport,
    column_count_for,
    compute_seed_slice,
    find_latest_batch_record,
    folio_side_for,
    job_state_name,
    load_alignment,
    parse_raw_result,
    resolve_batch_job_dir,
    save_alignment,
    save_conversation,
    service_tier_for,
    submit_batch,
    text_from_batch_response,
    write_poll_record,
)


def _document_order_placements(
    atom_start: int, atom_end: int
) -> list[tuple[int, int, int]]:
    """Deterministic placements: sequence atoms across 3 columns, ~3/line."""
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


def _alignment(seed_slice, word_stream):
    slice_words = word_stream.words[seed_slice.atom_start - 1 : seed_slice.atom_end]
    placements = _document_order_placements(seed_slice.atom_start, seed_slice.atom_end)
    return build_alignment_record(seed_slice, slice_words, placements)


def test_seed_slice_resolves_atom_range(seed_fixture: dict, word_stream) -> None:
    sl = compute_seed_slice(seed_fixture, "001B", word_stream)
    assert sl.folio == "001B"
    assert sl.book == "Genesis"
    assert sl.start_ref == "Genesis 1:1"
    assert sl.stop_ref == "Genesis 2:2"
    assert sl.atom_start == 1
    assert sl.atom_end == 10


def test_seed_slice_unknown_folio_raises(seed_fixture: dict, word_stream) -> None:
    with pytest.raises(ValueError):
        compute_seed_slice(seed_fixture, "999B", word_stream)


def test_seed_slice_unresolvable_verse_raises(seed_fixture: dict, word_stream) -> None:
    bad = {
        "header": {},
        "body": [
            {
                "page": "001B",
                "bkid": "Genesis",
                "startc": 99,
                "startv": 1,
                "startp": 1,
                "stopc": 1,
                "stopv": 1,
                "stopp": 1,
            }
        ],
    }
    with pytest.raises(ValueError):
        compute_seed_slice(bad, "001B", word_stream)


def test_build_preserves_atom_order_and_text(seed_slice, word_stream) -> None:
    rec = _alignment(seed_slice, word_stream)
    assert rec.folio == "001B"
    assert rec.alignment_method == AlignmentMethod.AI_VISION

    flat = [a for col in rec.columns for line in col.lines for a in line.atoms]
    assert [a.atom for a in flat] == list(range(1, 11))
    assert [a.text for a in flat] == [
        "בְּרֵאשִׁ֖ית",
        "בָּרָ֣א",
        "אֱלֹהִ֑ים",
        "וְהָאָ֗רֶץ",
        "בְּעֵ֖דֶן",
        "אֽוֹר׃",
        "אֶחָד",
        "י֔וֹם",
        "כֶּתֶב",
        "דָּבָר",
    ]


def test_build_lines_are_contiguous_and_bounded(seed_slice, word_stream) -> None:
    rec = _alignment(seed_slice, word_stream)
    for col in rec.columns:
        assert col.lines, "no empty columns"
        for line in col.lines:
            atoms = [a.atom for a in line.atoms]
            assert len(atoms) >= 1
            assert atoms == list(range(atoms[0], atoms[0] + len(atoms)))
            assert line.text_sample
            assert line.atom_start == atoms[0]
            assert line.atom_end == atoms[-1]


def test_build_verse_milestones(seed_slice, word_stream) -> None:
    rec = _alignment(seed_slice, word_stream)
    verses = [(m.verse, m.atom) for m in rec.verse_milestones]
    assert verses == [
        ("Genesis 1:1", 1),
        ("Genesis 1:2", 4),
        ("Genesis 1:3", 6),
        ("Genesis 2:1", 7),
        ("Genesis 2:2", 9),
    ]
    for m in rec.verse_milestones:
        assert 1 <= m.column <= 3
        assert m.atom in range(1, 11)


def test_build_section_milestones(seed_slice, word_stream) -> None:
    rec = _alignment(seed_slice, word_stream)
    sections = [(m.subtype, m.atom, m.verse) for m in rec.section_milestones]
    assert sections == [
        ("pe", 6, "Genesis 1:3"),
        ("samekh", 8, "Genesis 2:1"),
    ]
    for m in rec.section_milestones:
        assert 1 <= m.column <= 3
        assert m.line >= 1


def test_build_groups_by_column_and_line(seed_slice, word_stream) -> None:
    placements = [(1, 1, 1), (2, 1, 2), (3, 2, 1), (4, 2, 1)]
    slice_words = word_stream.words[:4]
    rec = build_alignment_record(seed_slice, slice_words, placements)
    assert len(rec.columns) == 2
    assert [c.column_number for c in rec.columns] == [1, 2]
    assert [l.line_number for l in rec.columns[0].lines] == [1, 2]
    assert [a.atom for a in rec.columns[1].lines[0].atoms] == [3, 4]


def test_folio_side_derived_from_folio() -> None:
    assert folio_side_for("001B") == "verso"
    assert folio_side_for("001A") == "recto"


def test_column_count_hint() -> None:
    assert column_count_for("Genesis") == 3
    assert column_count_for("Psalms") == 2
    assert column_count_for("Proverbs") == 2
    assert column_count_for("Job") == 2


def _placements_to_xml(placements: list[tuple[int, int, int]]) -> str:
    """Render placements as the TEI XML the model is asked to produce."""
    by_line: list[tuple[int, int, list[int]]] = []
    for atom, col, line in placements:
        if not by_line or by_line[-1][:2] != (col, line):
            by_line.append((col, line, [atom]))
        else:
            by_line[-1][2].append(atom)

    parts: list[str] = []
    cur_col = None
    for col, line, atoms in by_line:
        if col != cur_col:
            parts.append(f'<cb n="{col}" />')
            cur_col = col
        parts.append(f'<lb n="{line}" />')
        parts.append(" ".join("x" for _ in atoms))
    return "\n".join(parts)


def _xml_response(atom_start: int, atom_end: int) -> str:
    return _placements_to_xml(_document_order_placements(atom_start, atom_end))


def test_align_folio_ai_with_clean_response(seed_slice, word_stream, config) -> None:
    atom_start, atom_end = seed_slice.atom_start, seed_slice.atom_end

    def fake_request(_sl, _ws, _cfg, _prompt):
        return _xml_response(atom_start, atom_end)

    rec = align_folio_ai(seed_slice, word_stream, config, request=fake_request)
    assert rec.alignment_method == AlignmentMethod.AI_VISION
    assert rec.folio == "001B"
    flat = [a for col in rec.columns for line in col.lines for a in line.atoms]
    assert [a.atom for a in flat] == list(range(atom_start, atom_end + 1))
    assert rec.model_response == _xml_response(atom_start, atom_end)


def test_align_folio_ai_retries_on_bad_xml(seed_slice, word_stream, config) -> None:
    calls: list[str] = []

    def flaky(_sl, _ws, _cfg, prompt):
        calls.append(prompt)
        if len(calls) == 1:
            return "not xml at all"
        return _xml_response(seed_slice.atom_start, seed_slice.atom_end)

    rec = align_folio_ai(seed_slice, word_stream, config, request=flaky)
    assert len(calls) == 2
    assert rec.alignment_method == AlignmentMethod.AI_VISION


def test_align_folio_ai_retries_on_word_count_mismatch(
    seed_slice, word_stream, config
) -> None:
    calls = 0

    def half_words(_sl, _ws, _cfg, _prompt):
        nonlocal calls
        calls += 1
        if calls == 1:
            return _placements_to_xml([(1, 1, 1), (2, 1, 1), (3, 1, 1)])
        return _xml_response(seed_slice.atom_start, seed_slice.atom_end)

    rec = align_folio_ai(seed_slice, word_stream, config, request=half_words)
    assert calls == 2
    assert rec.alignment_method == AlignmentMethod.AI_VISION


def test_align_folio_ai_raises_after_retries(seed_slice, word_stream, config) -> None:
    def too_few_words(_sl, _ws, _cfg, _prompt):
        return _placements_to_xml([(1, 1, 1)])

    with pytest.raises(RuntimeError):
        align_folio_ai(seed_slice, word_stream, config, request=too_few_words)


def test_parse_epilog_multiple_columns_in_document_order() -> None:
    xml = '<cb n="1" /><lb n="1" />x y<lb n="2" />z<cb n="2" /><lb n="1" />a b c'
    assert _parse_epilog_xml(xml) == [(1, 1, 2), (1, 2, 1), (2, 1, 3)]


def test_parse_epilog_ignores_markers_and_verse_prefixes() -> None:
    xml = (
        '<cb n="1" />'
        '<lb n="1" />'
        '<milestone unit="chapter" n="1" />'
        '<milestone unit="verse" n="1" />'
        "x y z פ"
        '<lb n="2" />'
        "1  ׃1   a b"
    )
    assert _parse_epilog_xml(xml) == [(1, 1, 3), (1, 2, 2)]


def test_parse_epilog_attaches_standalone_paseq() -> None:
    xml = '<cb n="1" /><lb n="1" />אֱלֹהִ֤ים ׀ לָאוֹר<lb n="2" />x y'
    assert _parse_epilog_xml(xml) == [(1, 1, 2), (1, 2, 2)]


def test_parse_epilog_splits_maqaf_join_matching_expected() -> None:
    xml = '<cb n="1" /><lb n="1" />a\u05beb c'
    assert _parse_epilog_xml(xml, ["a\u05be", "b", "c"]) == [(1, 1, 3)]


def test_parse_epilog_keeps_whole_when_token_matches_expected() -> None:
    xml = '<cb n="1" /><lb n="1" />a\u05beb c'
    assert _parse_epilog_xml(xml, ["ab", "c"]) == [(1, 1, 2)]


def test_parse_epilog_merges_word_broken_across_lines() -> None:
    xml = '<cb n="1" /><lb n="1" />x ab<lb n="2" />cd y'
    assert _parse_epilog_xml(xml, ["x", "abcd", "y"]) == [(1, 1, 2), (1, 2, 1)]


def test_parse_epilog_line_before_blank_line_does_not_crash() -> None:
    # Regression for #515: the eager following-token lookup indexed [0]
    # into the next line's tokens without checking for a blank line.
    xml = '<cb n="1" /><lb n="1" />x y<lb n="2" /><lb n="3" />z'
    assert _parse_epilog_xml(xml, ["x", "y", "z"]) == [
        (1, 1, 2),
        (1, 2, 0),
        (1, 3, 1),
    ]


def test_parse_epilog_consecutive_and_trailing_blank_lines() -> None:
    xml = '<cb n="1" /><lb n="1" />x<lb n="2" /><lb n="3" /><lb n="4" />y'
    assert _parse_epilog_xml(xml, ["x", "y"]) == [
        (1, 1, 1),
        (1, 2, 0),
        (1, 3, 0),
        (1, 4, 1),
    ]
    trailing = '<cb n="1" /><lb n="1" />x y<lb n="2" />'
    assert _parse_epilog_xml(trailing, ["x", "y"]) == [(1, 1, 2), (1, 2, 0)]


def test_parse_epilog_does_not_merge_across_blank_line() -> None:
    xml = '<cb n="1" /><lb n="1" />ab<lb n="2" /><lb n="3" />cd'
    assert _parse_epilog_xml(xml, ["abcd", "e"]) == [
        (1, 1, 1),
        (1, 2, 0),
        (1, 3, 1),
    ]


def test_parse_epilog_strips_code_fence_and_xml_declaration() -> None:
    xml = '<?xml version="1.0"?>\n```xml\n<cb n="1" />\n<lb n="1" />\na b\n```'
    assert _parse_epilog_xml(xml) == [(1, 1, 2)]


def test_parse_epilog_rejects_text_outside_lines() -> None:
    with pytest.raises(ValueError):
        _parse_epilog_xml('stray text <cb n="1" /><lb n="1" />a b')


def test_place_words_assigns_atoms_sequentially() -> None:
    line_counts = [(1, 1, 2), (2, 1, 1), (2, 2, 3)]
    assert _place_words(line_counts, atom_start=7) == [
        (7, 1, 1),
        (8, 1, 1),
        (9, 2, 1),
        (10, 2, 2),
        (11, 2, 2),
        (12, 2, 2),
    ]


def test_save_load_alignment_persists_raw_response(
    tmp_path, seed_slice, word_stream
) -> None:
    rec = _alignment(seed_slice, word_stream)
    raw_xml = '<cb n="1" /><lb n="1" />x y'
    rec.model_response = raw_xml

    dest = tmp_path / "alignments" / "001B.json"
    save_alignment(rec, dest)

    assert (tmp_path / "alignments" / "raw" / "001B.xml").read_text() == raw_xml

    loaded = load_alignment(dest)
    assert loaded.model_response == raw_xml
    assert loaded.folio == "001B"
    assert loaded.section_milestones


def test_load_alignment_backfills_raw_from_file(
    tmp_path, seed_slice, word_stream
) -> None:
    rec = _alignment(seed_slice, word_stream)
    rec.model_response = '<cb n="1" /><lb n="1" />x y'
    dest = tmp_path / "alignments" / "001B.json"
    save_alignment(rec, dest)

    raw_path = tmp_path / "alignments" / "raw" / "001B.xml"
    raw_xml = '<cb n="1" /><lb n="1" />a b'
    raw_path.write_text(raw_xml)

    data = json.loads(dest.read_text())
    del data["model_response"]
    dest.write_text(json.dumps(data))

    loaded = load_alignment(dest)
    assert loaded.model_response == raw_xml


def test_align_folio_ai_writes_conversation(seed_slice, word_stream, config) -> None:
    atom_start, atom_end = seed_slice.atom_start, seed_slice.atom_end
    xml = _xml_response(atom_start, atom_end)

    def fake_request(_sl, _ws, _cfg, _prompt):
        return ModelResponse(
            text=xml,
            usage_metadata={
                "prompt_token_count": 1200,
                "candidates_token_count": 340,
                "total_token_count": 1540,
                "thoughts_token_count": 90,
            },
            parts=[
                {"thought": {"text": "trace..."}},
                {"text": xml},
            ],
        )

    align_folio_ai(seed_slice, word_stream, config, request=fake_request)

    conv_path = config.paths.alignments / "conversations" / "001B.json"
    assert conv_path.exists()
    conv = json.loads(conv_path.read_text())
    assert conv["folio"] == "001B"
    assert conv["model"] == config.ai.model
    from leningrad_codex_tei.stages.align import PROMPT_VERSION

    assert conv["prompt_version"] == PROMPT_VERSION
    assert conv["inference"] == config.ai.inference
    assert conv["response"] == xml
    assert [m["role"] for m in conv["messages"]] == ["user", "model"]
    assert conv["usage_metadata"]["total_token_count"] == 1540
    assert conv["usage_metadata"]["thoughts_token_count"] == 90
    assert conv["usage_metadata"]["prompt_token_count"] == 1200
    assert conv["messages"][1]["parts"][0]["thought"]["text"] == "trace..."
    assert conv["messages"][1]["text"] == xml


def test_model_response_from_generate_response() -> None:
    resp = types.GenerateContentResponse.model_construct(
        text='<cb n="1" />',
        candidates=[
            types.Candidate.model_construct(
                content=types.Content.model_construct(
                    parts=[types.Part.model_construct(text='<cb n="1" />')]
                ),
                index=0,
            )
        ],
        usage_metadata=types.GenerateContentResponseUsageMetadata.model_construct(
            prompt_token_count=1200,
            candidates_token_count=340,
            total_token_count=1540,
            thoughts_token_count=90,
        ),
    )

    mr = ModelResponse.from_generate_response(resp)
    assert mr.text == '<cb n="1" />'
    assert mr.usage_metadata["total_token_count"] == 1540
    assert mr.usage_metadata["thoughts_token_count"] == 90
    assert mr.usage_metadata["prompt_token_count"] == 1200
    assert mr.parts == [{"text": '<cb n="1" />'}]


def test_build_and_save_conversation(tmp_path) -> None:
    conv = build_conversation(
        folio="001B",
        prompt="map text",
        image_uri="data/images/BIB_LENCDX_F001B.jpg",
        model="gemini-3.7-flash",
        prompt_version="align-v3",
        inference="flex",
        response_text='<cb n="1" />',
        usage_metadata={"total_token_count": 10, "prompt_token_count": 4},
        parts=[{"text": '<cb n="1" />'}],
    )
    dest = save_conversation(conv, tmp_path / "alignments", "001B")
    assert dest == tmp_path / "alignments" / "conversations" / "001B.json"
    saved = json.loads(dest.read_text())
    assert saved["response"] == '<cb n="1" />'
    assert saved["usage_metadata"]["total_token_count"] == 10
    assert saved["messages"][0]["parts"][0]["image"].endswith("001B.jpg")
    assert saved["messages"][0]["parts"][1]["text"] == "map text"
    assert saved["messages"][1]["parts"] == [{"text": '<cb n="1" />'}]


def test_mime_for_suffix() -> None:
    assert _mime_for_suffix(".jpg") == "image/jpeg"
    assert _mime_for_suffix(".PNG") == "image/png"
    assert _mime_for_suffix(".tiff") == "image/tiff"
    assert _mime_for_suffix(".bin") == "image/jpeg"


def test_resolve_image_uploads_local_image_when_absent(tmp_path) -> None:
    image = tmp_path / "BIB_LENCDX_F001B.jpg"
    image.write_bytes(b"fake")

    class FakeFile:
        uri = "https://generativelanguage.googleapis.com/files/uploaded"

    class FakeFiles:
        uploads = []

        def get(self, name):
            raise Exception("not found")

        def upload(self, file, config):
            self.uploads.append((file, config))
            return FakeFile()

    client = type("Client", (), {"files": FakeFiles()})()
    uri, mime = _resolve_image(client, image)
    assert uri == "https://generativelanguage.googleapis.com/files/uploaded"
    assert mime == "image/jpeg"
    assert client.files.uploads[0][0] == image
    assert client.files.uploads[0][1].name == "bib-lencdx-f001b"
    assert client.files.uploads[0][1].display_name == "BIB_LENCDX_F001B"
    assert client.files.uploads[0][1].mime_type == "image/jpeg"


def test_resolve_image_reuses_cached_upload(tmp_path) -> None:
    image = tmp_path / "pic.jpg"
    image.write_bytes(b"fake")

    class FakeFiles:
        called_get = False

        def get(self, name):
            self.called_get = True
            return type("File", (), {"uri": "https://.../cached"})()

        def upload(self, file, config):
            raise AssertionError("upload should not be called when cached")

    client = type("Client", (), {"files": FakeFiles()})()
    uri, mime = _resolve_image(client, image)
    assert uri == "https://.../cached"
    assert client.files.called_get is True


def test_image_transport_config_validation() -> None:
    assert AiConfig(model="x", image_transport="encode").image_transport == "encode"
    assert AiConfig(model="x", image_transport="upload").image_transport == "upload"
    assert AiConfig(model="x").image_transport == "upload"
    with pytest.raises(ValueError):
        AiConfig(model="x", image_transport="bogus")


def test_generate_with_flex_uses_chat_and_returns_history(config) -> None:
    history_contents = [
        types.Content(role="user", parts=[types.Part(text="hi")]),
        types.Content(role="model", parts=[types.Part(text="hello")]),
    ]
    response = types.GenerateContentResponse.model_construct(
        text='<cb n="1" /><lb n="1" />x',
        candidates=[
            types.Candidate.model_construct(
                content=types.Content.model_construct(
                    parts=[types.Part(text='<cb n="1" /><lb n="1" />x')]
                ),
                index=0,
            )
        ],
        usage_metadata=types.GenerateContentResponseUsageMetadata.model_construct(
            total_token_count=11, prompt_token_count=4, thoughts_token_count=1
        ),
    )

    calls = {"create": 0, "send": 0, "get_history": 0}

    class FakeChat:
        def send_message(self, message, config):
            calls["send"] += 1
            return response

        def get_history(self):
            calls["get_history"] += 1
            return history_contents

    class FakeChats:
        def create(self, *, model, config):
            calls["create"] += 1
            return FakeChat()

    client = type("Client", (), {"chats": FakeChats()})()

    result = _generate_with_flex(client, config, message=[types.Part(text="hi")])

    assert calls["create"] == 1
    assert calls["send"] == 1
    assert calls["get_history"] == 1
    assert isinstance(result, ChatResult)
    assert result.response.text == '<cb n="1" /><lb n="1" />x'
    assert result.response.usage_metadata["total_token_count"] == 11
    assert [c["role"] for c in result.history] == ["user", "model"]
    assert result.history[0]["parts"][0]["text"] == "hi"


def test_image_part_from_bytes_inlines_base64(tmp_path) -> None:
    image = tmp_path / "folio.jpg"
    payload = b"\xff\xd8fakejpegbytes"
    image.write_bytes(payload)

    part = _image_part_from_bytes(image)
    assert part.inline_data is not None
    assert part.inline_data.mime_type == "image/jpeg"
    assert part.inline_data.data == payload


def test_image_part_from_upload_uses_uri(tmp_path) -> None:
    image = tmp_path / "folio.jpg"
    image.write_bytes(b"fake")

    class FakeFile:
        uri = "https://generativelanguage.googleapis.com/files/abc"

    class FakeFiles:
        def get(self, name):
            return FakeFile()

        def upload(self, file, config):
            raise AssertionError("upload should not be called when cached")

    part = _image_part_from_upload(type("Client", (), {"files": FakeFiles()})(), image)
    assert part.file_data is not None
    assert (
        part.file_data.file_uri == "https://generativelanguage.googleapis.com/files/abc"
    )
    assert part.file_data.mime_type == "image/jpeg"


def test_request_alignment_encode_transport_inlines_bytes(
    seed_slice, word_stream, config, monkeypatch
) -> None:
    image = config.paths.images / "BIB_LENCDX_F001B.jpg"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"payload")

    config.ai.image_transport = "encode"
    captured = {}

    def fake_generate(_client, _cfg, message):
        captured["message"] = message
        return ChatResult(
            response=ModelResponse(
                text='<cb n="1" /><lb n="1" />x', usage_metadata={}, parts=[]
            ),
            history=[],
        )

    import leningrad_codex_tei.stages.align as align_mod

    monkeypatch.setattr(align_mod, "_generate_with_flex", fake_generate)
    result = _request_alignment(seed_slice, word_stream, config, "prompt")
    assert result.response.text == '<cb n="1" /><lb n="1" />x'
    image_part = captured["message"][0]
    assert image_part.inline_data is not None
    assert image_part.inline_data.data == b"payload"


def test_request_alignment_upload_transport_uses_uri(
    seed_slice, word_stream, config, monkeypatch
) -> None:
    image = config.paths.images / "BIB_LENCDX_F001B.jpg"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"payload")

    config.ai.image_transport = "upload"
    captured = {}
    resolved: dict[str, list] = {"seen": []}

    def fake_generate(_client, _cfg, message):
        captured["message"] = message
        return ChatResult(
            response=ModelResponse(
                text='<cb n="1" /><lb n="1" />x', usage_metadata={}, parts=[]
            ),
            history=[],
        )

    def fake_resolve(client, path):
        resolved["seen"].append(path)
        return "https://.../uploaded", "image/jpeg"

    import leningrad_codex_tei.stages.align as align_mod

    monkeypatch.setattr(align_mod, "_generate_with_flex", fake_generate)
    monkeypatch.setattr(align_mod, "_resolve_image", fake_resolve)
    monkeypatch.setattr(
        align_mod, "_model_client", lambda _cfg: type("Client", (), {})()
    )
    result = _request_alignment(seed_slice, word_stream, config, "prompt")
    assert result.response.text == '<cb n="1" /><lb n="1" />x'
    assert resolved["seen"] == [image]
    image_part = captured["message"][0]
    assert image_part.file_data is not None
    assert image_part.file_data.file_uri == "https://.../uploaded"


def test_inference_config_validation() -> None:
    assert AiConfig(model="x", inference="standard").inference == "standard"
    assert AiConfig(model="x", inference="flex").inference == "flex"
    assert (
        AiConfig(model="x", inference="batch", image_transport="encode").inference
        == "batch"
    )
    with pytest.raises(ValueError):
        AiConfig(model="x", inference="bogus")
    with pytest.raises(ValueError):
        AiConfig(model="x", inference="batch", image_transport="upload")


def test_thinking_level_config_validation() -> None:
    assert AiConfig(model="x", thinking_level="low").thinking_level == "low"
    assert AiConfig(model="x", thinking_level="medium").thinking_level == "medium"
    assert AiConfig(model="x", thinking_level="high").thinking_level == "high"
    with pytest.raises(ValueError):
        AiConfig(model="x", thinking_level="minimal")
    with pytest.raises(ValueError):
        AiConfig(model="x", thinking_level="bogus")


def test_request_config_sets_thinking_level(config) -> None:
    from leningrad_codex_tei.stages.align import _request_config

    config.ai.thinking_level = "low"
    cfg = _request_config(config, None)
    assert cfg.thinking_config.thinking_level == types.ThinkingLevel.LOW


def test_service_tier_for_mapping(config) -> None:
    config.ai.inference = "standard"
    assert service_tier_for(config) is None
    config.ai.inference = "flex"
    assert service_tier_for(config) == "flex"
    config.ai.inference = "batch"
    assert service_tier_for(config) is None


def test_check_image_transport_batch_requires_encode(config) -> None:
    config.ai.inference = "batch"
    config.ai.image_transport = "upload"
    with pytest.raises(ValueError):
        check_image_transport(config)
    config.ai.image_transport = "encode"
    check_image_transport(config)


def test_check_image_transport_warns_on_encode_for_interactive(config) -> None:
    config.ai.inference = "flex"
    config.ai.image_transport = "encode"
    with pytest.warns(UserWarning):
        check_image_transport(config)


def test_ai_snapshot_covers_ai_block(config) -> None:
    snap = ai_snapshot(config)
    assert snap["inference"] == config.ai.inference
    assert snap["model"] == config.ai.model
    assert snap["image_transport"] == config.ai.image_transport
    assert snap["thinking_level"] == config.ai.thinking_level


def test_build_batch_request_line_inlines_image(
    seed_slice, word_stream, config
) -> None:
    image = config.paths.images / "BIB_LENCDX_F001B.jpg"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"payload")
    config.ai.inference = "batch"
    config.ai.image_transport = "encode"
    line = build_batch_request_line(seed_slice, word_stream, config, "map it")
    assert line["key"] == "001B"
    assert line["request"]["generation_config"] == {
        "thinking_config": {"thinking_level": config.ai.thinking_level}
    }
    parts = line["request"]["contents"][0]["parts"]
    assert parts[1] == {"text": "map it"}
    assert parts[0]["inline_data"]["mime_type"] == "image/jpeg"
    import base64

    assert base64.b64decode(parts[0]["inline_data"]["data"]) == b"payload"


def test_submit_batch_writes_jsonl_and_record(seed_slice, word_stream, config) -> None:
    from datetime import datetime

    image = config.paths.images / "BIB_LENCDX_F001B.jpg"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"payload")
    config.ai.inference = "batch"
    config.ai.image_transport = "encode"

    class FakeFiles:
        def upload(self, file, config):
            assert str(file).endswith(".jsonl")
            return type("F", (), {"name": "files/abc"})()

    class FakeBatches:
        def create(self, *, model, src, config):
            assert src == "files/abc"
            return type("J", (), {"name": "batches/123"})()

    client = type("Client", (), {"files": FakeFiles(), "batches": FakeBatches()})()
    record = submit_batch(
        [seed_slice],
        word_stream,
        config,
        client=client,
        now=datetime(2026, 1, 2, 3, 4, 5),
    )
    assert record["job_name"] == "batches/123"
    job_dir = config.paths.alignments / "batch" / "20260102T030405"
    upload = job_dir / "upload.jsonl"
    assert upload.exists()
    assert json.loads(upload.read_text().splitlines()[0])["key"] == "001B"
    dest = job_dir / "submit.json"
    assert dest.exists()
    assert find_latest_batch_record(config.paths.alignments / "batch") == dest
    assert (
        batch_job_dir(config.paths.alignments / "batch", "20260102T030405") == job_dir
    )
    resolved_dir, resolved = resolve_batch_job_dir(
        config.paths.alignments / "batch", "20260102T030405"
    )
    assert resolved_dir == job_dir
    assert resolved["job_name"] == "batches/123"
    resolved_dir, resolved = resolve_batch_job_dir(
        config.paths.alignments / "batch", "batches/123"
    )
    assert resolved_dir == job_dir


def test_text_from_batch_response_dict() -> None:
    resp = {"candidates": [{"content": {"parts": [{"text": "a"}, {"text": "b"}]}}]}
    assert text_from_batch_response(resp) == "ab"


def test_write_poll_record_and_state(tmp_path) -> None:
    from datetime import datetime

    class FakeState:
        name = "JOB_STATE_SUCCEEDED"

    job = type("J", (), {"name": "batches/1", "state": FakeState()})()
    job_dir = tmp_path / "20260102T030405"
    first = write_poll_record(job_dir, job, now=datetime(2026, 5, 1, 10, 0, 0))
    second = write_poll_record(job_dir, job, now=datetime(2026, 5, 1, 10, 5, 0))
    assert first == job_dir / "polls" / "20260501T100000.json"
    assert second == job_dir / "polls" / "20260501T100500.json"
    saved = json.loads(second.read_text())
    assert saved["status"] == "JOB_STATE_SUCCEEDED"
    assert saved["polled_at"].startswith("2026-05-01")
    assert saved["batch_timestamp"] == "20260102T030405"
    assert job_state_name(job) == "JOB_STATE_SUCCEEDED"
    assert batch_result_file_name({"dest": {"file_name": "files/out"}}) == "files/out"


def test_parse_raw_result_saves_alignment(
    seed_slice, word_stream, config
) -> None:
    xml = _xml_response(seed_slice.atom_start, seed_slice.atom_end)
    config.ai.inference = "batch"
    rec = parse_raw_result(
        "001B",
        xml,
        {"001B": seed_slice},
        word_stream,
        config,
        prompt="map it",
        job_name="batches/123",
    )
    assert rec.folio == "001B"
    assert (config.paths.alignments / "001B.json").exists()
    conv = json.loads(
        (config.paths.alignments / "conversations" / "001B.json").read_text()
    )
    assert conv["inference"] == "batch"
    assert conv["ai"]["batch_job"] == "batches/123"


def test_parse_raw_result_saves_raw_on_failure(
    seed_slice, word_stream, config
) -> None:
    config.ai.inference = "batch"
    with pytest.raises(ValueError):
        parse_raw_result(
            "001B",
            "not xml at all",
            {"001B": seed_slice},
            word_stream,
            config,
            prompt="map it",
            job_name="batches/123",
        )
    assert (
        config.paths.alignments / "raw" / "001B.xml"
    ).read_text() == "not xml at all"
    conv = json.loads(
        (config.paths.alignments / "conversations" / "001B.json").read_text()
    )
    assert conv["response"] == "not xml at all"
    assert not (config.paths.alignments / "001B.json").exists()


def test_parse_raw_result_skips_conversation_when_asked(
    seed_slice, word_stream, config
) -> None:
    config.ai.inference = "batch"
    xml = _xml_response(seed_slice.atom_start, seed_slice.atom_end)
    rec = parse_raw_result(
        "001B",
        xml,
        {"001B": seed_slice},
        word_stream,
        config,
        prompt="map it",
        job_name="batches/123",
        write_conversation=False,
    )
    assert rec.folio == "001B"
    assert (config.paths.alignments / "001B.json").exists()
    assert not (config.paths.alignments / "conversations" / "001B.json").exists()

    with pytest.raises(ValueError):
        parse_raw_result(
            "001B",
            "not xml at all",
            {"001B": seed_slice},
            word_stream,
            config,
            prompt="map it",
            job_name="batches/123",
            write_conversation=False,
        )
    assert (
        config.paths.alignments / "raw" / "001B.xml"
    ).read_text() == "not xml at all"
    assert not (config.paths.alignments / "conversations" / "001B.json").exists()


def test_prompt_version_is_sha_of_prompt() -> None:
    import hashlib

    from leningrad_codex_tei.stages.align import ALIGN_PROMPT, PROMPT_VERSION

    assert PROMPT_VERSION == hashlib.sha256(ALIGN_PROMPT.encode("utf-8")).hexdigest()
    assert len(PROMPT_VERSION) == 64


def test_ensure_align_prompt_clean_blocks_when_dirty(monkeypatch) -> None:
    import leningrad_codex_tei.stages.align as align_mod

    def _dirty(*a, **k):
        raise RuntimeError("uncommitted changes to align.py: commit or revert")

    monkeypatch.setattr("leningrad_codex_tei.util.git.require_file_clean", _dirty)
    with pytest.raises(RuntimeError, match="commit or revert"):
        align_mod.ensure_align_prompt_clean()


def test_parse_raw_result_uses_stored_prompt_version(
    seed_slice, word_stream, config
) -> None:
    xml = _xml_response(seed_slice.atom_start, seed_slice.atom_end)
    config.ai.inference = "batch"
    rec = parse_raw_result(
        "001B",
        xml,
        {"001B": seed_slice},
        word_stream,
        config,
        prompt="map it",
        job_name="batches/123",
        prompt_version="stored-hash",
    )
    assert rec.folio == "001B"
    conv = json.loads(
        (config.paths.alignments / "conversations" / "001B.json").read_text()
    )
    assert conv["prompt_version"] == "stored-hash"


def test_split_batch_result_lines() -> None:
    from leningrad_codex_tei.stages.align import split_batch_result_lines

    good = json.dumps(
        {
            "key": "001B",
            "response": {
                "candidates": [{"content": {"parts": [{"text": "<cb/>"}]}}]
            },
        }
    )
    lines = [
        good,
        json.dumps({"key": "002A", "error": {"message": "boom"}}),
        json.dumps({"key": "003B", "response": {}}),
        "not json",
        json.dumps({"nokey": True}),
    ]
    texts, errors = split_batch_result_lines(lines)
    assert texts == {"001B": "<cb/>"}
    assert errors["002A"]["kind"] == "api_error"
    assert errors["003B"]["kind"] == "empty_response"
    assert errors["line:3"]["kind"] == "bad_line"
    assert errors["line:4"]["kind"] == "missing_key"


def _parse_raw_config(config, seed_fixture, word_stream):
    """Write seed, word stream, and a config file for parse-raw tests."""
    import yaml

    from leningrad_codex_tei.stages import word_stream as stream_stage

    config.paths.seed.parent.mkdir(parents=True, exist_ok=True)
    config.paths.seed.write_text(json.dumps(seed_fixture))
    stream_stage.save_word_stream(word_stream, config.paths.word_stream)
    conf = config.paths.alignments.parent / "config.yaml"
    conf.write_text(
        yaml.safe_dump(
            {
                "project": {"name": "t", "version": "0.1.0-dev"},
                "paths": {k: str(v) for k, v in config.paths.__dict__.items()},
                "images": {"base_url": "https://example.invalid/", "naming": "F{folio}.jpg"},
                "seed": {
                    "upstream_url": "https://github.com/e/r",
                    "commit": "c",
                    "file": "f",
                },
                "uxlc": {"download_url": "https://example.invalid/z.zip"},
                "ai": {"model": "test-model", "inference": "batch", "image_transport": "encode"},
            }
        )
    )
    return conf


def test_parse_raw_parses_edited_raw(
    seed_fixture, seed_slice, word_stream, config
) -> None:
    """parse-raw reads raw/{folio}.xml so hand edits apply.

    Conversations belong to download-batch: a pre-existing conversation is
    left untouched and the audit run pins the raw sha that was parsed.
    """
    import hashlib

    from click.testing import CliRunner

    from leningrad_codex_tei.cli import cli

    conf = _parse_raw_config(config, seed_fixture, word_stream)
    raw = config.paths.alignments / "raw" / "001B.xml"
    raw.parent.mkdir(parents=True, exist_ok=True)
    # hand-edited raw: valid layout reply written after a failed attempt
    raw_text = _xml_response(seed_slice.atom_start, seed_slice.atom_end)
    raw.write_text(raw_text)
    conv_dir = config.paths.alignments / "conversations"
    conv_dir.mkdir(parents=True, exist_ok=True)
    (conv_dir / "001B.json").write_text(json.dumps({"marker": "download-wrote-me"}))

    result = CliRunner().invoke(
        cli, ["--config", str(conf), "parse-raw", "--folio", "001B"]
    )
    assert result.exit_code == 0, f"{result.output}\n{result.exception}"
    assert (config.paths.alignments / "001B.json").exists()
    assert json.loads((conv_dir / "001B.json").read_text()) == {
        "marker": "download-wrote-me"
    }
    summaries = list((config.paths.alignments / "parse-raw").glob("*.json"))
    assert len(summaries) == 1
    summary = json.loads(summaries[0].read_text())
    assert summary["succeeded"] == ["001B"]
    assert summary["failures"] == {}
    audit = json.loads((config.paths.audit / "001B.json").read_text())
    run = [r for r in audit["runs"] if r["stage"] == "parse-raw"][-1]
    assert run["result_summary"]["raw_sha256"] == hashlib.sha256(
        raw_text.encode("utf-8")
    ).hexdigest()


def test_parse_raw_scans_raw_dir(
    seed_fixture, seed_slice, word_stream, config
) -> None:
    """Without --folio, every raw response is parsed; failures don't stop others."""
    from click.testing import CliRunner

    from leningrad_codex_tei.cli import cli

    conf = _parse_raw_config(config, seed_fixture, word_stream)
    raw_dir = config.paths.alignments / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / "001B.xml").write_text(
        _xml_response(seed_slice.atom_start, seed_slice.atom_end)
    )
    (raw_dir / "999B.xml").write_text("not xml at all")

    result = CliRunner().invoke(cli, ["--config", str(conf), "parse-raw"])
    assert result.exit_code == 0, f"{result.output}\n{result.exception}"
    assert (config.paths.alignments / "001B.json").exists()
    assert not (config.paths.alignments / "999B.json").exists()
    summaries = list((config.paths.alignments / "parse-raw").glob("*.json"))
    assert len(summaries) == 1
    summary = json.loads(summaries[0].read_text())
    assert summary["succeeded"] == ["001B"]
    assert summary["failed_folios"] == ["999B"]


def test_download_batch_writes_raw_conversation_and_audit(
    seed_fixture, word_stream, config, monkeypatch
) -> None:
    """download-batch owns exchange records: raw + conversation from ground truth."""
    import hashlib

    from click.testing import CliRunner

    import leningrad_codex_tei.stages.align as align_mod
    from leningrad_codex_tei.cli import cli

    conf = _parse_raw_config(config, seed_fixture, word_stream)
    job_dir = config.paths.alignments / "batch" / "ts1"
    job_dir.mkdir(parents=True)
    (job_dir / "submit.json").write_text(
        json.dumps(
            {
                "job_name": "batches/123",
                "folios": ["001B"],
                "prompts": {"001B": "the prompt actually sent"},
                "prompt_version": "pv1",
            }
        )
    )
    result_lines = [
        json.dumps(
            {
                "key": "001B",
                "response": {
                    "candidates": [{"content": {"parts": [{"text": "hello raw"}]}}]
                },
            }
        ),
        json.dumps({"key": "002A", "error": {"message": "boom"}}),
    ]

    class _FakeFiles:
        def download(self, file):
            assert file == "files/out"
            return ("\n".join(result_lines)).encode("utf-8")

    class _FakeBatches:
        def get(self, name):
            assert name == "batches/123"
            return {
                "name": "batches/123",
                "state": "JOB_STATE_SUCCEEDED",
                "dest": {"file_name": "files/out"},
            }

    class _FakeClient:
        batches = _FakeBatches()
        files = _FakeFiles()

    monkeypatch.setattr(align_mod, "_model_client", lambda config: _FakeClient())

    result = CliRunner().invoke(cli, ["--config", str(conf), "download-batch"])
    assert result.exit_code == 0, f"{result.output}\n{result.exception}"

    assert (config.paths.alignments / "raw" / "001B.xml").read_text() == "hello raw"
    conv = json.loads(
        (config.paths.alignments / "conversations" / "001B.json").read_text()
    )
    user_text = conv["messages"][0]["parts"][1]["text"]
    assert user_text == "the prompt actually sent"
    assert conv["response"] == "hello raw"
    assert conv["prompt_version"] == "pv1"
    assert conv["ai"]["batch_job"] == "batches/123"

    summary = json.loads((job_dir / "download.json").read_text())
    assert summary["saved"] == ["001B"]
    assert summary["failed"] == ["002A"]

    audit = json.loads((config.paths.audit / "001B.json").read_text())
    run = [r for r in audit["runs"] if r["stage"] == "download-batch"][-1]
    assert run["result_summary"]["batch_job"] == "batches/123"
    assert run["result_summary"]["raw_sha256"] == hashlib.sha256(
        b"hello raw"
    ).hexdigest()

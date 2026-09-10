# AGENTS.md

## Responses

Always respond to the user in plain language using ISO 24495-1:2023.

## Glossary

- **Folio side**: One physical page of the codex, identified as `Fxxx{A|B}` (A = recto, B = verso). The atom of the edition: one TEI document per folio side.
- **Column**: A written column on a folio side. The codex has multiple columns per side.
- **Line**: A written line within a column. The finest unit of layout the edition encodes.
- **Word**: A single word of text. Carries biblical reference properties (book/chapter/verse).
- **Biblical reference**: Logical address (e.g. Exod 3:24). *Not* structural: marked by verse milestones within folio documents; per-word references are derived by the index build, not stored on each word.
- **Ketiv**: The consonantal text as written in the codex; what is physically on the page.
- **Verse milestone**: A TEI `<milestone unit="verse">` marking the point where a verse's text begins within a folio document; present on every folio that contains words of that verse, enabling per-folio search by reference.
- **samekh / pe**: Paragraph-division markers in the scroll. Samekh = open (petucha); pe = closed (setuma). Encoded as milestones with subtype.
- **Atom number**: Position index in the UXLC word stream. The seed mapping uses these to tie page boundaries to the textual base.
- **Seed mapping**: A pre-existing verse→location mapping used as the starting point for alignment, verified and corrected rather than derived from scratch.
- **Alignment**: Determining where a verse appears in the manuscript (column + line span) and encoding it.
- **Layout class**: The codex's column scheme for a page — 3-column prose (most sides), 2-column poetry (Ps/Prov/Job), or 1-column embedded song. Knowable from book metadata and the seed; drives column detection and prompt selection.
- **Locate-known-text**: The alignment method where the model is given the folio image plus the expected seeded words and maps the *known* atoms onto columns/lines, rather than transcribing the page cold.
- **Audit trail**: Per-folio record of which AI runs touched the folio: prompt version, model, inputs, results, check outcomes.
- **Verified folio**: A folio whose automated cross-checks passed and whose informal human review is complete.
- **Main biblical text**: The continuous scriptural text only; excludes marginalia (masora etc.) and Documentary Hypothesis tags.
- **Batch job**: One Batch API submission. Lives in `{alignments}/batch/{ts}/`, where `{alignments}` is `config.paths.alignments` (`data/alignments` by default) and `{ts}` is the submit timestamp.

## Batch job layout

Paths below are relative to `config.paths.alignments`. One directory per submission under `batch/{ts}/`:

- `submit.json`: Input manifest written at submit time. Job name, folio list, prompt per folio, model and settings.
- `upload.jsonl`: Request lines sent to the Batch API.
- `polls/{poll_ts}.json`: One status snapshot per `download-batch` poll. Never overwritten. Latest is the last file by name.

Per-folio results stay outside the job directory, shared with single runs:

- `{folio}.json`: Parsed alignment record.
- `raw/{folio}.xml`: Raw model reply, saved even on parse failure.
- `conversations/{folio}.json`: Prompt plus image plus response, saved even on parse failure.

`download-batch` accepts a timestamp, job directory, `submit.json` path, or API job name. It appends a poll file, then materializes each folio, saving raw plus conversation on failure and continuing past failures.
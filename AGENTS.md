# AGENTS.md

## About

To learn about this project, view the @README.md at the root of this repo.

## Responses

Always respond to the user in plain language using ISO 24495-1:2023.

## Versioning

- Single source of truth: root `pyproject.toml` `[project].version` (bare semver, e.g. `0.2.1`). Bump with `uv version --bump minor|patch|major` or `uv version X.Y.Z`. Note `uv version` only edits the file; the owner commits it and creates the release tag by hand.
- Git tags must equal `v<version>` (e.g. `v0.2.1`). The `deploy-viewer` and `release-bundle` workflows fail if the tag does not match the file.
- `site/scripts/sync-edition.mjs` reads `pyproject.toml` and writes the `v`-prefixed version to `site/src/data/meta.json`. It never uses `git describe`, because Netlify build checkouts may be branch-pinned or missing tags.
- `site/package.json` `version` is the private viewer app version and is unrelated to the edition version; do not bump it in lockstep.

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
- **Batch job**: One Batch API submission. Lives in `{alignments}/batch/{ts}/`, where `{alignments}` is `config.paths.alignments` and `{ts}` is the submit timestamp.

## Pipeline config paths

See `config.paths` in the active config (`config.yaml` by default, overridable via `--config`) for the actual location of these outputs on disk.

Below, `{name}` means `config.paths.{name}`.
The committed config maps these under `data/` (e.g. `{alignments}` is `data/alignments/`), except for `{output}`

- `{seed}`: vendored seed mapping (verse→location + atom spans); output of the `vendor-seed` step.
- `{uxlc}`: extracted UXLC book XMLs, including `.DH` variants; output of the `download-uxlc` step.
- `{images}`: folio JPGs per `config.images.naming`, fetched from `config.images.base_url`; output of the `download-images` step.
- `{word_stream}`: UXLC flattened into one word stream; input to alignment slices; output of the `build-word-stream` step.
- `{alignments}`:
    - `{alignments}/conversations/{folio}.json`: prompt + image + response (the exchange that produced the reply; written by `download-batch`, never rewritten by parsing)
    - `{alignments}/raw/{folio}.xml`: raw model reply
    - `{alignments}/{folio}.json`: parsed record (embeds source reply); the output used in the `generate-tei` step.
    - `{alignments}/parse-raw/{ts}.json`: parse summary for one `parse-raw` run (`{ts}` is the run timestamp; one file per run, never overwritten).
    - `{alignments}/batch/{ts}/`: one Batch API submission (`{ts}` is the submit timestamp); this is created when the `align-folio` step has `inference` set to `"batch"`
        - `submit.json`: manifest (job name, folios, per-folio prompts, model/settings); this is not sent to Batch API, but is a manifest in a format more easily ingested by humans (e.g. no base64 encoded data)
        - `upload.jsonl`: request lines sent to the Batch API
        - `polls/{poll_ts}.json`: append-only status snapshots; output of the `download-batch` step.
        - `result.jsonl`: raw Batch API result lines; output of the `download-batch` step when job completes.
        - `download.json`: per-folio download summary; output of the `download-batch` step when job completes.
- `{audit}`: per-folio `{folio}.json` audit runs.
- `{provenance}`: pins seed/UXLC/word-stream versions, hashes, and counts.
- `{output}`: generated per-folio TEI + `index.xml`; unlike the above, the contents of this path are intended to be committed.

**Note**: the `download-batch` command fetches results and puts the responses into `{alignments}/raw/` + `{alignments}/conversations/` (+ `{audit}` runs) without parsing; 
`parse-raw` parses `raw/` into `{folio}.json` (re-runnable after hand edits).
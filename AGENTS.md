# AGENTS.md

## About

To learn about this project, view the @README.md at the root of this repo.

## Responses

Always respond to the user in plain language using asd-ste100 simplified technical english.

## Git & Github

- use the `gh` cli if it is available
- run `uv run ruff format` before committing/pushing

## Contributing

See [CONTRIBUTING.MD](./CONTRIBUTING.MD) to assist with contributing.

## History

The initial work in this repo was geared towards using AI to create a digital edition of the Leningrad Codex.

When that work was completed, v1.0.0 was released. The pipeline steps are no longer relevant.

There may still be references to code and pipeline logic that are no longer relevant.

## Structure

Some of the most important directories are:

- `edition/`: this contains the XML files that compose the digital edition of the Leningrad Codex
- `site/`: this contains the code for transforming the XML files and building a public facing website
- `scripts/`: one off scripts used for processing files


## Versioning

Use the `/bump-version` skill to update the versioning for the `edition/` files.

In `site/`, the version in `package.json` is not related to the main versioning

## Glossary

- **Folio side**: One physical page of the codex, identified as `Fxxx{A|B}` (A = recto, B = verso). The atom of the edition: one TEI document per folio side.
- **Column**: A written column on a folio side. The codex has multiple columns per side.
- **Line**: A written line within a column. The finest unit of layout the edition encodes.
- **Word**: A single word of text. Carries biblical reference properties (book/chapter/verse). Exception: an erased word (a `<w>` inside a `<del>`) has no UXLC atom, no `xml:id` and no biblical reference.
- **Biblical reference**: Logical address (e.g. Exod 3:24). *Not* structural: marked by verse milestones within folio documents; per-word references are derived by the index build, not stored on each word.
- **Ketiv**: The consonantal text as written in the codex; what is physically on the page.
- **Verse milestone**: A TEI `<milestone unit="verse">` marking the point where a verse's text begins within a folio document; present on every folio that contains words of that verse, enabling per-folio search by reference.
- **samekh / pe**: Paragraph-division markers in the codex. Pe = open (petucha); samekh = closed (setuma). Encoded as milestones with subtype.
- **Atom number**: Position index in the UXLC word stream. The seed mapping uses these to tie page boundaries to the textual base.
- **Seed mapping**: A pre-existing verse→location mapping used as the starting point for alignment, verified and corrected rather than derived from scratch.
- **Segment**: One contiguous atom range of a folio side's slice. Seed records that touch in the word stream merge into one segment. A side gets more than one segment only where the codex book order differs from the word stream (e.g. `409B` runs Job then Proverbs). Segments stay in page order.
- **Alignment**: Determining where a verse appears in the manuscript (column + line span) and encoding it.
- **Layout class**: The codex's column scheme for a page — 3-column prose (most sides), 2-column poetry (Ps/Prov/Job), or 1-column embedded song. Knowable from book metadata and the seed; drives column detection and prompt selection.
- **Locate-known-text**: The alignment method where the model is given the folio image plus the expected seeded words and maps the *known* atoms onto columns/lines, rather than transcribing the page cold.
- **Audit trail**: Per-folio record of which AI runs touched the folio: prompt version, model, inputs, results, check outcomes.
- **Verified folio**: A folio whose automated cross-checks passed and whose informal human review is complete.
- **Main biblical text**: The continuous scriptural text only; excludes marginalia (masora etc.), Documentary Hypothesis tags, and erased text.
- **Erasure**: Writing that the scribe erased. Encoded by hand (not a pipeline stage; `generate-tei` does not keep it) as `<del rend="erasure">`, one per line so `<lb>` stays a child of `<ab>`. The parts of an erasure that crosses lines or columns are joined with `@next`/`@prev`; ids are `f{folio}-del-{column}-{line}`. Readable erased words are `<w>` with no `xml:id`, holding the consonants and only the marks that can be seen (e.g. rafe); a visible sof pasuq is `<pc>`. Text that cannot be read is `<gap reason="illegible"/>`. A `<del>` never holds `<lb>`, `<cb>` or a milestone, and verse milestones stay outside it. Code that reads words from the edition must skip a `<w>` inside a `<del>`. See the `del` spec in `leningrad-odd.xml`.
- **Verse zone**: A TEI `<zone type="verse">` in the facsimile with one child zone per line segment of the verse, in Archive.org image pixels. The verse milestone points to it with `facs`. Source: Masoretica HTR (Idan Dershowitz), added to a committed folio by `scripts/zones.py` as a hand edit, not a pipeline stage; `generate-tei` does not keep it.
- **Batch job**: One Batch API submission. Lives in `{alignments}/batch/{ts}/`, where `{alignments}` is `config.paths.alignments` and `{ts}` is the submit timestamp.

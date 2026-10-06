---
name: view-batch-result
description: Show a batch result.jsonl file in a form a human can read.
---

# View Batch Result

Show what the model did in one batch job. The raw file
(`{alignments}/batch/<ts>/result.jsonl`) is hard to read: each line
holds code runs, tool outputs, base64 images (many MB), and the final
text. The script hides the base64 and shows a short step list plus the
final text as one line per column and line.

Use the repo glossary in `AGENTS.md`: a **folio side** is `Fxxx{A|B}`;
a **batch job** lives in `{alignments}/batch/{ts}/`.

## Steps

1. **Find the result file.**
   Default path is `data/alignments/batch/<ts>/result.jsonl`
   (see `config.paths.alignments`; `<ts>` is the submit time).
   For a folio `$FOLIO`, the prompt is in `submit.json`
   under `prompts[$FOLIO]`. Completion: the file exists.

2. **Show the full job.**
   `python3 .agents/skills/view-batch-result/scripts/view_result.py <result.jsonl>`
   Per folio it shows: end state, step count
   (code runs, tool outputs, images, text parts), model,
   full token counts (total, prompt, tool use, out, cached,
   thoughts, plus TEXT/IMAGE split per part) and cost estimate
   (3.8 Flash batch global rates),
   then each step: short code view, tool output, image size
   (never base64), and the final text as `c<COL> l<LINE>: words`.
   Completion: no base64 is printed.

3. **Focus or export as needed.**
   - One folio: add `--folio 031B`.
   - Full code: add `--full-code`.
   - Raw final XML only: add `--text-only`.
   - Save model images to files: add `--save-images <dir>`
     (files are `<folio>-<n>.jpg|.png`, safe to open).
   Completion: the user sees only the part they asked for.

## Notes

- Lines with an API `error` or no text print as errors in the
  end count (`Done: N ok, M error`).
- The script uses only the standard library. No new packages.

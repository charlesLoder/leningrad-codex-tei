# Later: line zones from the verse zones

Status: idea, not started. Write-up from the `scripts/zones.py add` work (October 2026).

## Summary

`scripts/zones.py add` writes one `<zone type="verse">` per verse. Each verse zone holds one child zone per line segment of the verse. Each line segment is on one line, and `scripts/zones.py add` checks that the number of segments equals the number of lines that the verse covers in the edition. So each segment can be linked to a specific `<cb>`/`<lb>`.

With that link, we can encode the line layout of each folio side, not only where each verse is. This is the "codex as an object" goal in the README.

## What it adds

1. **A zone for each line.** Merge all segments that belong to the same (column, line) into one `<zone type="line">`, and put `facs="#…"` on that `<lb>`. A line holds parts of one or more verses. Its zone is the union (bounding box) of those parts.
2. **A zone for each column.** Optional. Make it the bounding box of the column's line zones, and put `facs` on each `<cb>`.
3. **Line links on segments.** Optional. Put `corresp="#f001B-lb-1-3"` on each verse segment zone, so that a verse zone also tells which lines it is on.

Example (001B, column 1, line 3: the start of Gen 1:2):

```xml
<zone xml:id="f001B-zone-l1-3" type="line" ulx="2813" uly="1540" lrx="3533" lry="1699"/>
...
<lb xml:id="f001B-lb-1-3" n="3" facs="#f001B-zone-l1-3"/>
```

## How

- Do it in `scripts/zones.py add` (or as a second step after it). It already has the pairs `(column, line) → rect` for each verse that passes its checks (`verse_lines` and `check_verse` in `scripts/zones.py`).
- A line gets a zone only when every verse part on it passed. When a verse is left out, its lines are not covered completely, so do not write a zone for those lines.
- Add `facs` to `<lb>`/`<cb>` the same way `_patch_milestones` adds it to the verse milestones: edit the text in place and keep hand edits.
- Site: the IIIF build can add a second annotation page ("Lines"). The viewer can then highlight the line that the cursor is on in the transcription.

## Known gaps to fix first

From the first run over the 196 edition folios: 4,826 verse zones passed and 105 were left out.

- **Song of the Sea (Exod 15, 040A–040B), 14 left out.** This is the brick-over-half-brick song layout. Each written line has 2 or 3 separate blocks of text, so Masoretica gives more than one rect per line. The check counts rects per line, so these verses fail. To fix: for the 1-column embedded song **layout class**, merge rects that have the same line band before the check.
- **Repeated text (Num 7, the offerings of the tribal leaders).** The text is almost the same for each leader, so the HTR sometimes matches the wrong one. The lines are then in the wrong order. These verses are correctly left out. A line zone needs a correct verse zone, so these lines have none.
- **Margin noise that stays.** `drop_margin_rects` removes the rects in the top and bottom margins. Small false matches in a text column (e.g. Exod 2:22 on 032A) stay, and the check rejects those verses.
- **One extra rect at the start of a verse** (e.g. Gen 14:3 on 007B, where a small rect is at the end of the line before). Masoretica puts the first word of the verse on the line before. The edition puts it at the start of the next line. This can be an **alignment** error in the edition. Examine these verses before you add line zones. The `scripts/zones.py add` output lists them ("left out …: N zone rects, M edition lines").

## Coordinate space

All zones use the pixels of the Archive.org image (`f<FOLIO>-img-archive`), not the Sefaria graphic. The Sefaria image is a cropped copy. Line zones use the same space. To show them on the Sefaria image, you need a transform from one image to the other. The IIIF pipeline does not need one, because it paints the Archive.org image.

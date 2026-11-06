# Leningrad Viewer (`site/`)

Astro viewer for the digital edition of the Leningrad Codex, read from the TEI files in `/edition`. Treated as a separate
project: its own dependencies, README, and Netlify deployment.

## Develop

Prerequisites: Node.js 26+.

```bash
cd site
npm install
npm run dev
```

The dev server reads TEI directly from `../edition/`.

## How it works

- `npm run sync` (also runs before every build) copies
  `../edition/*.xml` into `public/edition/` and regenerates
  `src/data/folios.json` from `../edition/index.xml`.
  Generated files are gitignored; Netlify rebuilds them.
- `/` lists every folio side, paginated, with a client-side filter.
  The build embeds the folio list as JSON and server-renders only the
  first page; the browser filters the full list, then renders one page
  at a time. The query and page are kept in the URL (`?q=…&page=…`).
- `/folio/Fxxx[A|B]/` renders columns and lines as encoded in TEI,
  with verse milestones, samekh/pe divisions, sof-pasuq and paseq inline.
  The text and the page image share one verse selection, built from the
  `<zone type="verse">` segments in the TEI. A link such as
  `/folio/021A/#Gen-34-12` opens with that verse selected. A double click on
  the text zooms the image to the verse, and opens the image if it is closed.
- The page image uses `triiiceratops`, pinned to an exact version. All calls
  to it live in `src/lib/iiif-stage.ts`. Its controls and annotation shapes
  are off, and that module draws the zones in its own overlay. The ruler and
  color chart stay hidden behind a mask from `leafBounds` in
  `src/lib/folio-view.ts`, which is an estimate and not a measurement.
- `/folios.json` is the folio list for the go-to search. The browser fetches
  it only when a reader opens the search.
- Raw TEI per folio is served at `/edition/Fxxx[A|B].xml`.

## Deploy (Netlify)

- Base directory: `site`
- Build command: `npm run build`
- Publish directory: `site/dist`
- A `netlify.toml` with these settings is included.

Builds run only when `site/` changes (via the `ignore` command).
New `edition/` content ships on version tags: the deploy workflow
(`.github/workflows/deploy-viewer.yml`) fires a Netlify build hook,
which picks up the tag for the `(vX)` header label.

To finish wiring it up: create a build hook under
Site settings → Build & deploy → Build hooks, and store its URL
in the `NETLIFY_SITE_BUILD_HOOK` repo secret.

No server or adapter is needed; output is fully static.

# Leningrad Viewer (`site/`)

Astro viewer for the TEI files in `/edition`. Treated as a separate
project: its own dependencies, README, and Netlify deployment.

## Develop

Prerequisites: Node.js 18+.

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
- `/` lists every folio side with a client-side filter.
- `/folio/Fxxx[A|B]/` renders columns and lines as encoded in TEI,
  with verse milestones, samekh/pe divisions, sof-pasuq and paseq inline.
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

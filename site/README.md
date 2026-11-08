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

Run `npm run check` to type check the site with `tsc`, and `npm test` for the unit tests.
The check covers the `.ts` files only. Checking `.astro` files with `tsc` needs
TypeScript 7.1 and `@astrojs/ts-content-mapper`, which replaces `astro check`.

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
- `/codex/` shows the codex as a 3D book. `/codex/#021A` opens it at a folio
  side, and `/codex/#021A/Gen-34-12` also selects a verse. The code is in
  `src/lib/codex/`:
  - Each page is a DOM element inside a WebGL canvas, drawn with the
    [HTML-in-Canvas](https://github.com/WICG/html-in-canvas) API. After each
    draw, `updateElementGeometry` tells the browser where the page landed, so
    native selection, copy, and find-in-page work on the page, also when the
    reader tilts the book. Only pages at rest take the pointer.
  - The open book lies as on a book scanner. A cradle holds both open pages
    level and flat. Zoomed all the way out, the book tilts away from the
    reader, and it flattens to a straight-down view on the way in. The
    fore-edges slant out, so the paper on each side still shows.
  - A turning leaf follows a planned curve (`planFlight` in `math.ts`). While a
    leaf moves, a new page is built in pieces, one per frame (`piece` in
    `page-store.ts`), and the store reads one opening ahead in the direction of
    travel. Freeing pages, uploading photographs, and repainting pages that
    already have a picture wait for the landing.
  - The verse zones place each line where the photograph has it
    (`layoutFolio` in `layout.ts`). The lens shows the same line in ink. The
    photo mode shows the photograph alone, with no selectable text. The zones
    are from a recognition pass, so a side can be a little off; a side with no
    usable zones uses an even grid.
  - Each page is drawn into a texture once, at a fixed size, so zooming in
    would blur it. When the view rests while zoomed in, `gl-view.ts` lays out a
    copy of the part of each page on screen, enlarged with CSS zoom, and draws
    it at the size of the screen over the page. While it shows, the copy takes
    the pointer and the selection in place of the page. It costs about one
    screen of memory at any zoom.
  - The scene takes its colors from the tokens in `src/styles/global.css`
    (`theme.ts`). The desk and controls follow the theme toggle. The paper and
    its ink use the `--page-*` tokens, which stay the same in every theme.
  - A photograph loads as a small preview and then a sharp version, and the
    neighboring pages get their previews ahead of time.
  - At 820px wide or narrower, or 500px tall or shorter, the page shows a
    message and a link to the matching folio page, and does not load the book.
    The media query in `src/pages/codex.astro` alone sets these sizes.
  - Add `?slow=4` to the URL to play every movement four times slower, up to
    `?slow=20`. This helps to see a page turn frame by frame.
  - Zoomed in, a drag that starts off the text moves the view, and a drag on
    the text selects it. On a touch screen one finger moves the view anywhere.
  - The API needs Chrome 157 or later. Other browsers get `css-view.ts`, a
    plain book with rigid leaves. Add `?renderer=css` to the URL to test it.
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

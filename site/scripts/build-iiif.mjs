/**
 * IIIF build step: TEI verse zones -> IIIF Presentation 3 Manifest.
 *
 * Reads per-folio TEI from `edition/` (sibling of `site/`). The surface is
 * in Archive.org image pixels and holds the Archive.org graphic
 * (`f<FOLIO>-img-archive`, added by `scripts/zones.py add`) beside the
 * Sefaria one. Each verse `<zone type="verse">` holds one child zone per
 * line segment (`ulx, uly, lrx, lry`); the segments merge into one SVG
 * outline per column part. Writes one manifest per folio with verse
 * annotations to `public/iiif/<FOLIO>.json` using `@iiif/builder`.
 *
 * Only folios with zones get a manifest.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { IIIFBuilder } from '@iiif/builder';
import { splitColumnSegments, verseSvg } from './rect-union.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '..');
const repoRoot = join(siteRoot, '..');
const editionDir = join(repoRoot, 'edition');
const outDir = join(siteRoot, 'public', 'iiif');

const SITE_URL = process.env.SITE_URL ?? 'https://leningrad-codex-tei.netlify.app';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
});

const toArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

// `Kings_1-21-10` -> `1 Kings 21:10`
export function formatRef(n) {
  const m = String(n).match(/^(.+)-(\d+)-(\d+)$/);
  if (!m) return String(n).replace(/-/g, ' ');
  const book = m[1].replace(/^(.+)_(\d)$/, '$2 $1').replace(/_/g, ' ');
  return `${book} ${m[2]}:${m[3]}`;
}

export function buildManifest(folio, tei) {
  const doc = parser.parse(tei);
  const teiRoot = doc.TEI ?? doc['TEI'];
  const surface = teiRoot?.facsimile?.surface;
  const graphics = toArray(surface?.graphic);
  // Paint the Archive.org image: the zones are in its pixels, and it has a
  // tiled Image API service, so viewers get deep zoom. The Sefaria graphic
  // is a cropped copy in other pixels, so it cannot carry the zones.
  const IIIF_FULL_SUFFIX = '/full/max/0/default.jpg';
  const iiifGraphic = graphics.find((g) => String(g?.id ?? '').endsWith('-img-archive'));
  if (!iiifGraphic) return null;
  const paintUrl = String(iiifGraphic.url);
  const serviceId = paintUrl.endsWith(IIIF_FULL_SUFFIX)
    ? paintUrl.slice(0, -IIIF_FULL_SUFFIX.length)
    : null;
  const width = Math.round(Number(surface?.lrx ?? 0));
  const height = Math.round(Number(surface?.lry ?? 0));
  const titleNode = teiRoot?.teiHeader?.fileDesc?.titleStmt?.title;
  const title = typeof titleNode === 'string' ? titleNode : `Leningrad Codex — ${folio}`;

  const manifestId = `${SITE_URL}/iiif/${folio}.json`;
  const canvasId = `${SITE_URL}/iiif/${folio}/canvas`;
  const builder = new IIIFBuilder();
  // Collected inside the canvas callback (runs synchronously) so targets
  // can be restored after the vault round-trip below.
  let wantTargets = new Map();
  builder.createManifest(manifestId, (manifest) => {
    manifest.addLabel(title, 'en');
    manifest.addSummary(`Folio ${folio} of the Leningrad Codex with verse zones.`, 'en');
    manifest.createCanvas(canvasId, (canvas) => {
      const canvasWidth = width || 1;
      const canvasHeight = height || 1;
      canvas.width = canvasWidth;
      canvas.height = canvasHeight;
      canvas.addLabel(`Folio ${folio}`, 'en');
      if (paintUrl) {
        const paintId = `${canvasId}/painting`;
        const body = {
          id: paintUrl,
          type: 'Image',
          format: 'image/jpeg',
          width: canvasWidth,
          height: canvasHeight,
        };
        if (serviceId) {
          body.service = [{ id: serviceId, type: 'ImageService3', profile: 'level2' }];
        }
        canvas.createAnnotation(paintId, {
          id: paintId,
          type: 'Annotation',
          motivation: 'painting',
          body,
        });
      }
      // Verse zones are in edition order already.
      const zones = toArray(surface?.zone).filter((z) => z?.type === 'verse');
      const idPrefix = `f${folio}-zone-`;
      // One annotation per verse: all line rects merge into a single
      // polygon (union outline) used as an SVG selector target, so the
      // viewer shows one shape per verse instead of N boxes.
      const annoItems = [];
      for (const z of zones) {
        const zid = z.id ?? z['xml:id'];
        if (!zid) continue;
        const ref = formatRef(String(zid).replace(idPrefix, ''));
        const rects = [];
        for (const r of toArray(z.zone)) {
          const ulx = Number(r.ulx);
          const uly = Number(r.uly);
          const w = Number(r.lrx) - ulx;
          const h = Number(r.lry) - uly;
          if (![ulx, uly, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
          rects.push({ x: ulx, y: uly, w, h });
        }
        const svg = (rs) => verseSvg(rs, canvasWidth, canvasHeight);
        // One annotation per verse. A verse spanning a column break
        // (e.g. Genesis 1:10) keeps one polygon per column part, but as
        // multiple targets of the single annotation rather than separate
        // annotations.
        const parts = splitColumnSegments(rects, canvasHeight);
        const targets = [];
        for (const part of parts) {
          const partSvg = svg(part);
          if (partSvg === null) continue;
          targets.push({
            source: canvasId,
            selector: { type: 'SvgSelector', value: partSvg },
          });
        }
        if (targets.length === 0) continue;
        annoItems.push({
          id: `${manifestId}/annotation/${zid}`,
          type: 'Annotation',
          motivation: 'commenting',
          // No `label`: the panel renders a raw annotation label object
          // as "[object Object]", and the body already names the verse.
          body: { type: 'TextualBody', value: ref, format: 'text/plain' },
          target: targets.length === 1 ? targets[0] : targets,
        });
      }
      wantTargets = new Map(annoItems.map((a) => [a.id, a.target]));
      if (annoItems.length > 0) {
        // `true` puts the page on `annotations` (supplementing), keeping
        // `items` for the painting only.
        canvas.createAnnotationPage(
          `${canvasId}/verses`,
          (page) => {
            for (const a of annoItems) page.createAnnotation(a);
          },
          true,
        );
      }
    });
  });
  const manifest = builder.toPresentation3({ id: manifestId, type: 'Manifest' });
  // The vault mangles complex targets (it collapses target lists and
  // drops SVG selectors), so restore the per-verse targets verbatim.
  for (const canvas of manifest.items ?? []) {
    for (const page of canvas.annotations ?? []) {
      for (const anno of page.items ?? []) {
        if (wantTargets.has(anno.id)) anno.target = wantTargets.get(anno.id);
      }
    }
  }
  return { manifestId, manifest };
}

function main(only) {
  const files = readdirSync(editionDir)
    .filter((f) => f.endsWith('.xml') && f !== 'index.xml')
    .filter((f) => (only ? f === `${only}.xml` : true));

  let wrote = 0;
  mkdirSync(outDir, { recursive: true });
  for (const f of files) {
    const folio = f.replace(/\.xml$/, '');
    const tei = readFileSync(join(editionDir, f), 'utf8');
    if (!tei.includes('<zone')) continue;
    const built = buildManifest(folio, tei);
    if (!built) continue;
    writeFileSync(join(outDir, `${folio}.json`), JSON.stringify(built.manifest, null, 2) + '\n');
    wrote += 1;
  }
  console.log(`Built ${wrote} IIIF manifest(s) to public/iiif/`);
}

// Build only when run as a script, not when imported by tests.
if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv[2] ?? null);

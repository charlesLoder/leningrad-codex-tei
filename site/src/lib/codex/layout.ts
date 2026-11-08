/**
 * Where each line of a folio side sits on the page. The verse zones come from the
 * photograph, so the transcription can sit on the photographed lines: the lens then
 * shows the same line in ink and in type. No DOM here.
 */
import { lineHtml, buildViewData, leafBounds } from '../folio-view.ts';
import type { FolioDoc, ZoneSegment } from '../tei.ts';
import { PAGE_H, PAGE_W } from './math.ts';

/** A region of the photograph, in image pixels, with the proportions of a page. */
export type Crop = [number, number, number, number];

export interface LaidLine {
  n: string;
  /** Vertical middle of the line, as a share of the page height. */
  y: number;
  html: string;
  /** The line ends short on purpose, as a paragraph division does. */
  short: boolean;
}

export interface LaidColumn {
  n: string;
  /** Edges of the column, as a share of the page width. */
  left: number;
  right: number;
  /** Distance between lines, as a share of the page height. */
  pitch: number;
  lines: LaidLine[];
}

export interface FolioLayout {
  crop: Crop | null;
  /** True when the lines came from the photograph, not from an even grid. */
  registered: boolean;
  columns: LaidColumn[];
}

/**
 * The document with the outermost zone segments left out. Recognition misplaces a
 * few segments on an unusual page such as the Song of the Sea, and one stray segment
 * would otherwise inflate the bounds of the leaf.
 */
function withoutStrayZones(doc: FolioDoc): FolioDoc {
  const all = Object.values(doc.facsimile.zones).flatMap((z) => z.segments);
  if (all.length < 8) return doc;
  const trim = Math.ceil(all.length * 0.03);
  const edge = (values: number[], fromEnd: boolean): number => {
    const sorted = [...values].sort((a, b) => (fromEnd ? b - a : a - b));
    return sorted[trim];
  };
  const left = edge(all.map((s) => s[0]), false);
  const top = edge(all.map((s) => s[1]), false);
  const right = edge(all.map((s) => s[2]), true);
  const bottom = edge(all.map((s) => s[3]), true);
  const zones = Object.fromEntries(
    Object.entries(doc.facsimile.zones).map(([ref, zone]) => [
      ref,
      { ...zone, segments: zone.segments.filter((s) => s[0] >= left && s[1] >= top && s[2] <= right && s[3] <= bottom) },
    ]),
  );
  return { ...doc, facsimile: { ...doc.facsimile, zones } };
}

/**
 * The leaf from `leafBounds`, grown to the proportions of a page and moved to stay
 * inside the photograph. It stays exact, so the photograph is never stretched.
 */
export function pageCrop(doc: FolioDoc): Crop | null {
  const { width, height } = doc.facsimile;
  if (!width || !height) return null;
  const leaf = leafBounds(withoutStrayZones(doc)) ?? [width * 0.11, height * 0.115, width * 0.78, height * 0.75];
  const aspect = PAGE_W / PAGE_H;
  let w = leaf[2];
  let h = leaf[3];
  if (w / h < aspect) w = h * aspect;
  else h = w / aspect;
  if (w > width) {
    w = width;
    h = w / aspect;
  }
  if (h > height) {
    h = height;
    w = h * aspect;
  }
  const x = Math.min(width - w, Math.max(0, leaf[0] + leaf[2] / 2 - w / 2));
  const y = Math.min(height - h, Math.max(0, leaf[1] + leaf[3] / 2 - h / 2));
  return [Math.round(x), Math.round(y), Math.round(w), Math.round(h)];
}

/** The IIIF URL of a crop, at most `maxWidth` pixels wide. */
export const cropUrl = (service: string, crop: Crop, maxWidth = 1100): string =>
  `${service}/${crop.join(',')}/${Math.min(maxWidth, crop[2])},/0/default.jpg`;

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/** Line fit `y = a + b * line`, refit once without points far from the first fit. */
function fitLines(points: { line: number; y: number }[]): { a: number; b: number } | null {
  const fit = (pts: typeof points) => {
    const mx = pts.reduce((s, p) => s + p.line, 0) / pts.length;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const den = pts.reduce((s, p) => s + (p.line - mx) ** 2, 0);
    if (!den) return null;
    const b = pts.reduce((s, p) => s + (p.line - mx) * (p.y - my), 0) / den;
    return { a: my - b * mx, b };
  };
  const first = fit(points);
  if (!first) return null;
  const kept = points.filter((p) => Math.abs(first.a + first.b * p.line - p.y) < Math.abs(first.b) * 0.6);
  return kept.length >= 3 ? fit(kept) : first;
}

/** Segments for each `column/line`, from the verses whose segments map one to one to their lines. */
function segmentsByLine(doc: FolioDoc): Map<string, ZoneSegment[]> {
  const view = buildViewData(doc, { folio: '', version: '', manifest: null, prev: null, next: null });
  const out = new Map<string, ZoneSegment[]>();
  for (const verse of view.verses) {
    if (verse.segments.length !== verse.lines.length) continue;
    verse.lines.forEach(([col, line], i) => {
      const key = `${col}/${line}`;
      if (!out.has(key)) out.set(key, []);
      out.get(key)?.push(verse.segments[i]);
    });
  }
  return out;
}

const isShort = (doc: FolioDoc, col: number, line: number): boolean => {
  const tokens = doc.columns[col].lines[line].tokens;
  const last = tokens[tokens.length - 1];
  return tokens.length === 0 || (last?.marks.some((m) => m.kind === 'section') ?? false);
};

/** Columns in an even grid, for the side with no zones. Column 1 is on the right. */
function evenColumns(doc: FolioDoc): LaidColumn[] {
  const n = doc.columns.length;
  const rows = Math.max(1, ...doc.columns.map((c) => c.lines.length));
  const span = 0.7 / n;
  const pitch = 0.68 / rows;
  return doc.columns.map((col, i) => ({
    n: col.n,
    right: 0.85 - span * i - span * 0.05,
    left: 0.85 - span * (i + 1) + span * 0.05,
    pitch,
    lines: col.lines.map((line, r) => ({ n: line.n, y: 0.16 + pitch * (r + 0.5), html: lineHtml(line), short: isShort(doc, i, r) })),
  }));
}

export function layoutFolio(doc: FolioDoc): FolioLayout {
  const crop = pageCrop(doc);
  const segments = segmentsByLine(doc);
  if (!crop || segments.size === 0) return { crop, registered: false, columns: evenColumns(doc) };
  const [cx, cy, cw, ch] = crop;
  const columns: LaidColumn[] = [];
  for (const [i, col] of doc.columns.entries()) {
    const points = col.lines.flatMap((line) =>
      (segments.get(`${col.n}/${line.n}`) ?? []).map((s) => ({ line: Number(line.n), y: (s[1] + s[3]) / 2, s })),
    );
    const fit = points.length >= 3 ? fitLines(points) : null;
    if (!fit || fit.b <= 0) return { crop, registered: false, columns: evenColumns(doc) };
    // A verse may fill only part of a line, so each edge comes from the segments that reach furthest.
    const lefts = points.map((p) => p.s[0]).sort((a, b) => a - b);
    const rights = points.map((p) => p.s[2]).sort((a, b) => b - a);
    const third = Math.max(1, Math.ceil(points.length / 3));
    const left = (median(lefts.slice(0, third)) - cx) / cw;
    const right = (median(rights.slice(0, third)) - cx) / cw;
    const lines = col.lines.map((line, r) => ({
      n: line.n,
      y: (fit.a + fit.b * Number(line.n) - cy) / ch,
      html: lineHtml(line),
      short: isShort(doc, i, r),
    }));
    if (right <= left || lines.some((l) => l.y < 0 || l.y > 1)) return { crop, registered: false, columns: evenColumns(doc) };
    columns.push({ n: col.n, left, right, pitch: fit.b / ch, lines });
  }
  return { crop, registered: true, columns };
}

/** The text of a verse across folio sides, spaced as `lineHtml` spaces it. */
export function verseText(docs: FolioDoc[], ref: string): string {
  let out = '';
  for (const doc of docs) {
    for (const col of doc.columns) {
      for (const line of col.lines) {
        for (const token of line.tokens) {
          if (token.verse !== ref) continue;
          if (out && token.kind !== 'sof-pasuq' && !out.endsWith('־')) out += ' ';
          out += token.text;
        }
      }
    }
  }
  return out;
}

/**
 * The width to add to each space so a line fills its column as a scribe's line does.
 * A line that ends short, or would need gaps too wide to read, stays as it is.
 */
export function justifySpacing(natural: number, column: number, spaces: number, fontSize: number, short: boolean): number {
  if (short || spaces === 0 || natural >= column || natural < column * 0.72) return 0;
  const add = (column - natural) / spaces;
  return add > fontSize * 1.1 ? 0 : add;
}

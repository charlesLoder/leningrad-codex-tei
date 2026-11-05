/**
 * Pure helpers for the folio page: the data the browser needs, the HTML of one
 * manuscript line, verse links, and the go-to search. No DOM access here.
 */
import { filterFolios, type FolioRow } from './folio-list.ts';
import type { FolioDoc, TeiColumn, TeiLine, Token, ZoneSegment } from './tei.ts';
import { folioRangeSpans, parseVerseQuery } from './verses.ts';

export interface ViewVerse {
  /** Reference, e.g. `Gen 34:12`. */
  ref: string;
  /** Recognition score of the zone, or null. */
  cert: number | null;
  /** Zone segments in image pixels; empty when the verse has no zone. */
  segments: ZoneSegment[];
  /** The `[column, line]` pairs that hold the verse, in reading order. */
  lines: [string, string][];
}

export interface NeighborFolio {
  folio: string;
  range: string;
}

export interface FolioViewData {
  folio: string;
  version: string;
  /** Manifest URL, or null for a folio with no verse zones. */
  manifest: string | null;
  imageService: string | null;
  width: number | null;
  height: number | null;
  /** The leaf in image pixels: `[x, y, width, height]`. */
  leaf: [number, number, number, number] | null;
  verses: ViewVerse[];
  prev: NeighborFolio | null;
  next: NeighborFolio | null;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

function verseLines(columns: TeiColumn[]): Map<string, [string, string][]> {
  const out = new Map<string, [string, string][]>();
  for (const col of columns) {
    for (const line of col.lines) {
      for (const ref of new Set(line.tokens.map((t) => t.verse))) {
        if (!ref) continue;
        if (!out.has(ref)) out.set(ref, []);
        out.get(ref)?.push([col.n, line.n]);
      }
    }
  }
  return out;
}

/**
 * Estimate the leaf inside the photo, which also holds a ruler and a color chart.
 * The leaf is a near-constant share of each photo, and the zones place it. This
 * is an estimate, not a measurement; "With ruler" always shows the whole photo.
 */
export function leafBounds(doc: FolioDoc): FolioViewData['leaf'] {
  const { width, height, zones } = doc.facsimile;
  const segs = Object.values(zones).flatMap((z) => z.segments);
  if (!width || !height || segs.length === 0) return null;
  const left = Math.min(...segs.map((s) => s[0]));
  const top = Math.min(...segs.map((s) => s[1]));
  const right = Math.max(...segs.map((s) => s[2]));
  const bottom = Math.max(...segs.map((s) => s[3]));
  const centerX = doc.columns.length > 1 ? (left + right) / 2 : width * 0.536;
  const w = Math.max(width * 0.78, (right - left) * 1.26);
  const h = Math.max(height * 0.75, (bottom - top) * 1.3);
  const x = Math.max(0, centerX - w / 2);
  const y = Math.max(height * 0.115, (top + bottom) / 2 - h / 2);
  return [Math.round(x), Math.round(y), Math.round(Math.min(w, width - x)), Math.round(Math.min(h, height - y))];
}

export function buildViewData(
  doc: FolioDoc,
  opts: {
    folio: string;
    version: string;
    manifest: string | null;
    prev: NeighborFolio | null;
    next: NeighborFolio | null;
  },
): FolioViewData {
  const lines = verseLines(doc.columns);
  return {
    ...opts,
    imageService: doc.facsimile.imageService,
    width: doc.facsimile.width,
    height: doc.facsimile.height,
    leaf: leafBounds(doc),
    verses: doc.verses.map((ref) => ({
      ref,
      cert: doc.facsimile.zones[ref]?.cert ?? null,
      segments: doc.facsimile.zones[ref]?.segments ?? [],
      lines: lines.get(ref) ?? [],
    })),
  };
}

function sectionHtml(subtype: string): string {
  const [glyph, title] =
    subtype === 'samekh'
      ? ['ס', 'Closed paragraph (setuma)']
      : subtype === 'pe'
        ? ['פ', 'Open paragraph (petucha)']
        : [escapeHtml(subtype), 'Paragraph division'];
  return `<span class="section-tag" title="${title}">${glyph}</span>`;
}

function verseNumber(ref: string, firstVerse: string | null): string {
  const m = ref.match(/(\d+):(\d+)$/);
  if (!m) return escapeHtml(ref);
  return m[2] === '1' || ref === firstVerse ? `${m[1]}:${m[2]}` : m[2];
}

/**
 * One manuscript line as HTML. Words of the same verse share a `.verse-run`, so
 * a highlight also covers the spaces between them. No space follows a maqaf or
 * comes before a sof pasuq.
 */
export function lineHtml(line: TeiLine, firstVerse: string | null = null): string {
  const runs: { verse: string | null; tokens: Token[] }[] = [];
  for (const token of line.tokens) {
    const last = runs[runs.length - 1];
    if (last && last.verse === token.verse) last.tokens.push(token);
    else runs.push({ verse: token.verse, tokens: [token] });
  }
  const tokenHtml = (t: Token): string => {
    const start = t.marks.some((m) => m.kind === 'verse') && t.verse
      ? `<span class="verse-num">${verseNumber(t.verse, firstVerse)}</span>`
      : '';
    const text = escapeHtml(t.text);
    const body = t.kind === 'w' ? text : `<span class="${t.kind}">${text}</span>`;
    const sections = t.marks.flatMap((m) => (m.kind === 'section' ? [sectionHtml(m.subtype)] : [])).join('');
    return start + body + sections;
  };
  const noSpaceAfter = (t: Token): boolean => t.text.endsWith('־');
  let html = '';
  runs.forEach((run, r) => {
    let body = '';
    run.tokens.forEach((t, i) => {
      body += tokenHtml(t);
      const next = run.tokens[i + 1];
      if (next && next.kind !== 'sof-pasuq' && !noSpaceAfter(t)) body += ' ';
    });
    html += `<span class="verse-run" data-verse="${escapeHtml(run.verse ?? '')}">${body}</span>`;
    const lastToken = run.tokens[run.tokens.length - 1];
    if (r < runs.length - 1 && !noSpaceAfter(lastToken)) html += ' ';
  });
  for (const mark of line.marks) html += ` ${sectionHtml(mark.subtype)}`;
  return html;
}

/** `Gen 34:12` -> `Gen-34-12` */
export const refToHash = (ref: string): string => ref.replace(/[\s:]+/g, '-');

/** The verse key of a reference, for comparison across spellings of a book. */
export const refKey = (ref: string): number | null => parseVerseQuery(ref)?.start ?? null;

/** `Gen-34-12` or `exodus-3-14` -> a verse key, or null when it names no verse. */
export function hashToKey(hash: string): number | null {
  const m = hash.replace(/^#/, '').match(/^(.+)-(\d+)-(\d+)$/);
  return m ? refKey(`${decodeURIComponent(m[1]).replace(/-/g, ' ')} ${m[2]}:${m[3]}`) : null;
}

/** `Column 2, lines 16–22`; a verse that crosses columns lists each part. */
export function lineSummary(lines: [string, string][]): string {
  const byColumn = new Map<string, number[]>();
  for (const [col, line] of lines) {
    if (!byColumn.has(col)) byColumn.set(col, []);
    byColumn.get(col)?.push(Number(line));
  }
  return [...byColumn]
    .map(([col, ns]) => {
      const a = Math.min(...ns);
      const b = Math.max(...ns);
      return `Column ${col}, line${a === b ? ` ${a}` : `s ${a}–${b}`}`;
    })
    .join('; ');
}

/** The folios that a verse crosses into, for the selected-verse card. */
export function verseNeighbors(data: FolioViewData, ref: string): { label: string; folio: string }[] {
  const key = refKey(ref);
  const out: { label: string; folio: string }[] = [];
  if (key === null) return out;
  if (data.prev && folioRangeSpans(data.prev.range).at(-1)?.end === key) out.push({ label: 'Starts on', folio: data.prev.folio });
  if (data.next && folioRangeSpans(data.next.range)[0]?.start === key) out.push({ label: 'Continues on', folio: data.next.folio });
  return out;
}

export interface GoToHit {
  folio: string;
  range: string;
  href: string;
}

/** Search the folio list as the home page does. Folios whose name starts with the query come first. */
export function searchFolios(list: [string, string][], query: string, limit = 5): GoToHit[] {
  const q = query.trim();
  if (!q) return [];
  const rows: FolioRow[] = list.map(([folio, range]) => ({
    folio,
    range,
    search: `${folio} ${range}`.toLowerCase(),
    spans: folioRangeSpans(range),
  }));
  const needle = q.toLowerCase();
  const span = parseVerseQuery(q);
  const hash = span && span.start === span.end ? `#${encodeURIComponent(refToHash(q))}` : '';
  return filterFolios(rows, q)
    .sort((a, b) => Number(b.folio.toLowerCase().startsWith(needle)) - Number(a.folio.toLowerCase().startsWith(needle)))
    .slice(0, limit)
    .map((r) => ({ folio: r.folio, range: r.range, href: `/folio/${r.folio}/${hash}` }));
}

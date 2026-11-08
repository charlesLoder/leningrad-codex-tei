/**
 * The codex as a bound object: which folio sides face each other, and where each
 * book of the Bible falls. No DOM here.
 *
 * A Hebrew codex has its spine on the right when closed, and its leaves turn from
 * left to right. Leaf N shows its recto (`A`) on the left and then, once turned,
 * its verso (`B`) on the right. An opening is therefore the verso of leaf N on the
 * right and the recto of leaf N + 1 on the left: `001B` faces `002A`.
 */
import { abbreviateRange } from '../tei.ts';

export interface Opening {
  /** The number of the leaf whose verso is on the right. */
  n: number;
  /** Folio side on the right, or null when the edition has no such side. */
  right: string | null;
  left: string | null;
}

export interface BookSpan {
  /** The name as the folio list has it, e.g. `Samuel_1`. */
  book: string;
  /** SBL abbreviation, e.g. `1 Sam`. */
  label: string;
  /** Group in codex order: Torah, Prophets, Writings. */
  section: 'torah' | 'prophets' | 'writings';
  /** The first opening that shows the book. */
  start: number;
  /** The first opening after the book, for its share of the codex. */
  end: number;
}

export const sideId = (leaf: number, side: 'A' | 'B'): string => `${String(leaf).padStart(3, '0')}${side}`;

/** `021A` is on the left of the opening of leaf 20; `021B` is on the right of the opening of leaf 21. */
export function openingOfSide(side: string): number | null {
  const m = side.match(/^(\d{3})([AB])$/);
  if (!m) return null;
  return m[2] === 'B' ? Number(m[1]) : Number(m[1]) - 1;
}

export function openingRange(sides: string[]): { first: number; last: number } {
  const ns = sides.flatMap((s) => openingOfSide(s) ?? []);
  return { first: Math.min(...ns), last: Math.max(...ns) };
}

/** Sides the edition does not have (e.g. `120B`) stay null, and show as bare parchment. */
export function openingAt(n: number, known: ReadonlySet<string>): Opening {
  const right = sideId(n, 'B');
  const left = sideId(n + 1, 'A');
  return { n, right: known.has(right) ? right : null, left: known.has(left) ? left : null };
}

const TORAH = new Set(['Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy']);
const WRITINGS_START = 'Chronicles_1';

/** Every book in the order the codex has it, which is not the order of a printed Bible. */
export function bookSpans(list: [string, string][]): BookSpan[] {
  const out: BookSpan[] = [];
  let writings = false;
  for (const [side, range] of list) {
    const n = openingOfSide(side);
    if (n === null) continue;
    for (const part of range.split(/\s*[;–]\s*/)) {
      const book = part.match(/^(.+?) \d/)?.[1];
      if (!book || out.some((b) => b.book === book)) continue;
      if (book === WRITINGS_START) writings = true;
      out.push({
        book,
        label: abbreviateRange(book),
        section: TORAH.has(book) ? 'torah' : writings ? 'writings' : 'prophets',
        start: n,
        end: n,
      });
    }
  }
  const { last } = openingRange(list.map(([side]) => side));
  out.forEach((b, i) => {
    b.end = out[i + 1]?.start ?? last + 1;
  });
  return out;
}

/** The book at an opening: the last one that starts on or before it. */
export function bookAt(spans: BookSpan[], n: number): BookSpan | null {
  let hit: BookSpan | null = null;
  for (const span of spans) if (span.start <= n) hit = span;
  return hit;
}

/** Up to `limit` evenly spaced steps between two openings, for riffling across many leaves. */
export function riffleSteps(from: number, to: number, limit = 14): number[] {
  const distance = Math.abs(to - from);
  if (distance === 0) return [];
  const count = Math.min(distance, limit);
  const sign = Math.sign(to - from);
  return Array.from({ length: count }, (_, i) => from + sign * Math.round((distance * (i + 1)) / count));
}

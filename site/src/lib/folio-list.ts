import { parseVerseQuery, spanOverlaps, type VerseSpan } from './verses.ts';

export interface FolioRow {
  folio: string;
  range: string;
  search: string;
  spans: VerseSpan[];
}

export interface PageSlice {
  page: number;
  pages: number;
  from: number;
  to: number;
}

export function filterFolios(rows: FolioRow[], raw: string): FolioRow[] {
  const query = raw.trim();
  if (!query) return rows;
  const span = parseVerseQuery(query);
  if (span) {
    return rows.filter((row) => row.spans.some((s) => spanOverlaps(s, span)));
  }
  const needle = query.toLowerCase();
  return rows.filter((row) => row.search.includes(needle));
}

// Pages are 1-based; an out-of-range page is clamped into [1, pages].
export function paginate(total: number, page: number, size: number): PageSlice {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const from = (current - 1) * size;
  return { page: current, pages, from, to: Math.min(from + size, total) };
}

export function countLabel(slice: PageSlice, matches: number, raw: string): string {
  const query = raw.trim();
  if (matches === 0) return query ? `No published folio matches “${query}”.` : 'No published folios.';
  const shown = `${slice.from + 1}–${slice.to} of ${matches} folio${matches === 1 ? '' : 's'}`;
  return query ? `${shown} matching “${query}”` : shown;
}

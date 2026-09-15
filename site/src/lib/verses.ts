export interface VerseSpan {
  start: number;
  end: number;
}

const BOOKS: { display: string; aliases: string[] }[] = [
  { display: 'Genesis', aliases: ['genesis', 'gen', 'gn', 'ge'] },
  { display: 'Exodus', aliases: ['exodus', 'exod', 'exo', 'ex'] },
  { display: 'Leviticus', aliases: ['leviticus', 'lev', 'le', 'lv'] },
  { display: 'Numbers', aliases: ['numbers', 'num', 'nu', 'nm', 'nb'] },
  { display: 'Deuteronomy', aliases: ['deuteronomy', 'deut', 'deu', 'de', 'dt'] },
  { display: 'Joshua', aliases: ['joshua', 'josh', 'jos'] },
  { display: 'Judges', aliases: ['judges', 'judg', 'jdg', 'jgs', 'jg'] },
  { display: '1 Samuel', aliases: ['1 samuel', '1 sam', '1 sa', 'samuel 1', '1samuel', '1sam', '1sa'] },
  { display: '2 Samuel', aliases: ['2 samuel', '2 sam', '2 sa', 'samuel 2', '2samuel', '2sam', '2sa'] },
  { display: '1 Kings', aliases: ['1 kings', '1 kgs', '1 kg', '1 ki', 'kings 1', '1kings', '1kgs', '1ki'] },
  { display: '2 Kings', aliases: ['2 kings', '2 kgs', '2 kg', '2 ki', 'kings 2', '2kings', '2kgs', '2ki'] },
  { display: 'Isaiah', aliases: ['isaiah', 'isa', 'is'] },
  { display: 'Jeremiah', aliases: ['jeremiah', 'jer', 'je'] },
  { display: 'Ezekiel', aliases: ['ezekiel', 'ezek', 'eze', 'ez'] },
  { display: 'Hosea', aliases: ['hosea', 'hos', 'ho'] },
  { display: 'Joel', aliases: ['joel', 'jl'] },
  { display: 'Amos', aliases: ['amos', 'am'] },
  { display: 'Obadiah', aliases: ['obadiah', 'obad', 'ob'] },
  { display: 'Jonah', aliases: ['jonah', 'jon', 'jnh'] },
  { display: 'Micah', aliases: ['micah', 'mic', 'mi'] },
  { display: 'Nahum', aliases: ['nahum', 'nah', 'na'] },
  { display: 'Habakkuk', aliases: ['habakkuk', 'hab', 'hb'] },
  { display: 'Zephaniah', aliases: ['zephaniah', 'zeph', 'zp'] },
  { display: 'Haggai', aliases: ['haggai', 'hag', 'hg'] },
  { display: 'Zechariah', aliases: ['zechariah', 'zech', 'zc'] },
  { display: 'Malachi', aliases: ['malachi', 'mal', 'ml'] },
  { display: 'Psalms', aliases: ['psalms', 'psalm', 'ps', 'psa'] },
  { display: 'Proverbs', aliases: ['proverbs', 'prov', 'pro', 'pr'] },
  { display: 'Job', aliases: ['job', 'jb'] },
  { display: 'Song of Songs', aliases: ['song of songs', 'song', 'songs', 'sos'] },
  { display: 'Ruth', aliases: ['ruth', 'ru'] },
  { display: 'Lamentations', aliases: ['lamentations', 'lam', 'la'] },
  { display: 'Ecclesiastes', aliases: ['ecclesiastes', 'eccl', 'ecc', 'ec'] },
  { display: 'Esther', aliases: ['esther', 'esth', 'est', 'es'] },
  { display: 'Daniel', aliases: ['daniel', 'dan', 'da'] },
  { display: 'Ezra', aliases: ['ezra', 'ezr'] },
  { display: 'Nehemiah', aliases: ['nehemiah', 'neh', 'ne'] },
  { display: '1 Chronicles', aliases: ['1 chronicles', '1 chr', '1 ch', '1 chron', 'chronicles 1', '1chronicles', '1chr', '1ch'] },
  { display: '2 Chronicles', aliases: ['2 chronicles', '2 chr', '2 ch', '2 chron', 'chronicles 2', '2chronicles', '2chr', '2ch'] },
];

const BOOK_LOOKUP = new Map<string, number>();
for (let i = 0; i < BOOKS.length; i++) {
  for (const alias of BOOKS[i].aliases) {
    if (!BOOK_LOOKUP.has(alias)) BOOK_LOOKUP.set(alias, i);
  }
}

export function normalizeBook(raw: string): string {
  return raw.toLowerCase().replace(/[.]/g, '').replace(/[ _]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function bookIndex(name: string): number | null {
  const hit = BOOK_LOOKUP.get(normalizeBook(name));
  return hit === undefined ? null : hit;
}

export function verseKey(book: number, chapter: number, verse: number): number {
  return book * 1000000 + chapter * 1000 + verse;
}

function parseSingleRef(ref: string): VerseSpan | null {
  const m = ref.match(/^(.+?)\s+(\d+)\s*:\s*(\d+)\s*$/);
  if (!m) return null;
  const book = bookIndex(m[1]);
  if (book === null) return null;
  const key = verseKey(book, Number(m[2]), Number(m[3]));
  return { start: key, end: key };
}

export function folioRangeKeys(range: string): { start: number | null; end: number | null } {
  if (!range || !range.trim()) return { start: null, end: null };
  const parts = range.split(/\s*[–—]\s*/);
  const bounds = parts.length > 1 ? parts : range.split(/\s+-\s+/);
  if (bounds.length === 1) {
    const single = parseSingleRef(bounds[0]);
    return single ? { start: single.start, end: single.end } : { start: null, end: null };
  }
  const first = parseSingleRef(bounds[0]);
  const last = parseSingleRef(bounds[bounds.length - 1]);
  if (!first || !last) return { start: null, end: null };
  return { start: Math.min(first.start, last.start), end: Math.max(first.end, last.end) };
}

export function parseVerseQuery(input: string): VerseSpan | null {
  const m = input.trim().match(/^(.*?)\s*(\d+)\s*(?::\s*(\d+)(?:\s*[–—-]\s*(\d+))?)?\s*$/);
  if (!m || !m[1]) return null;
  const book = bookIndex(m[1]);
  if (book === null) return null;
  const chapter = Number(m[2]);
  if (!m[3]) {
    return { start: verseKey(book, chapter, 0), end: verseKey(book, chapter, 999) };
  }
  const from = Number(m[3]);
  const to = m[4] ? Number(m[4]) : from;
  return {
    start: verseKey(book, chapter, Math.min(from, to)),
    end: verseKey(book, chapter, Math.max(from, to)),
  };
}

export function spanOverlaps(a: VerseSpan, b: VerseSpan): boolean {
  return a.start <= b.end && b.start <= a.end;
}

export interface FolioEntry {
  folio: string;
  href: string;
  title: string;
  range: string;
}

export interface VerseMark {
  kind: 'verse';
  ref: string;
}

export interface SectionMark {
  kind: 'section';
  subtype: string;
}

export type InlineMark = VerseMark | SectionMark;

export interface Token {
  text: string;
  kind: 'w' | 'sof-pasuq' | 'paseq';
  marks: InlineMark[];
  verse: string | null;
}

export interface TeiLine {
  n: string;
  tokens: Token[];
}

export interface TeiColumn {
  n: string;
  lines: TeiLine[];
}

export interface FolioDoc {
  title: string;
  graphicUrl: string | null;
  columns: TeiColumn[];
  verses: string[];
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/(\w[\w:.-]*)\s*=\s*"([^"]*)"/g)) {
    out[m[1]] = m[2];
  }
  return out;
}

const SBL_ABBREVIATIONS: Record<string, string> = {
  Genesis: 'Gen',
  Exodus: 'Exod',
  Leviticus: 'Lev',
  Numbers: 'Num',
  Deuteronomy: 'Deut',
  Joshua: 'Josh',
  Judges: 'Judg',
  Ruth: 'Ruth',
  Samuel_1: '1 Sam',
  Samuel_2: '2 Sam',
  Kings_1: '1 Kgs',
  Kings_2: '2 Kgs',
  Chronicles_1: '1 Chr',
  Chronicles_2: '2 Chr',
  Ezra: 'Ezra',
  Nehemiah: 'Neh',
  Esther: 'Esth',
  Job: 'Job',
  Psalms: 'Ps',
  Proverbs: 'Prov',
  Ecclesiastes: 'Eccl',
  Song_of_Songs: 'Song',
  Isaiah: 'Isa',
  Jeremiah: 'Jer',
  Lamentations: 'Lam',
  Ezekiel: 'Ezek',
  Daniel: 'Dan',
  Hosea: 'Hos',
  Joel: 'Joel',
  Amos: 'Amos',
  Obadiah: 'Obad',
  Jonah: 'Jonah',
  Micah: 'Mic',
  Nahum: 'Nah',
  Habakkuk: 'Hab',
  Zephaniah: 'Zeph',
  Haggai: 'Hag',
  Zechariah: 'Zech',
  Malachi: 'Mal',
};

function formatRef(n: string): string {
  const m = n.match(/^(.+)-(\d+)-(\d+)$/);
  if (!m) return n.replace(/-/g, ' ');
  const book = SBL_ABBREVIATIONS[m[1]] ?? SBL_ABBREVIATIONS[m[1].replace(/\.DH$/, '')] ?? m[1].replace(/_/g, ' ');
  return `${book} ${m[2]}:${m[3]}`;
}

export function parseFolioXml(xml: string): FolioDoc {
  const title = xml.match(/<title>([^<]+)<\/title>/)?.[1] ?? 'Folio';
  const graphicUrl = xml.match(/<graphic[^>]*url="([^"]+)"/)?.[1] ?? null;
  const body = xml.match(/<div type="edition">([\s\S]*?)<\/div>/)?.[1] ?? '';

  const columns: TeiColumn[] = [];
  const verses: string[] = [];
  let currentCol: TeiColumn = { n: '1', lines: [] };
  let currentLine: TeiLine | null = null;
  let pending: InlineMark[] = [];
  let started = false;
  let currentVerse: string | null = null;

  const flushLine = () => {
    if (currentLine) currentCol.lines.push(currentLine);
    currentLine = null;
  };

  const tokenRe =
    /<cb\b[^>]*>|<lb\b[^>]*>|<milestone\b[^>]*\/>|<(w|pc)\b[^>]*>([\s\S]*?)<\/\1>/g;

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(body)) !== null) {
    const tag = m[0];
    if (tag.startsWith('<cb')) {
      flushLine();
      if (started) columns.push(currentCol);
      currentCol = { n: attrs(tag)['n'] ?? String(columns.length + 1), lines: [] };
      started = true;
    } else if (tag.startsWith('<lb')) {
      flushLine();
      currentLine = { n: attrs(tag)['n'] ?? '', tokens: [] };
      started = true;
    } else if (tag.startsWith('<milestone')) {
      const a = attrs(tag);
      if (a['unit'] === 'verse' && a['n']) {
        const ref = formatRef(a['n']);
        if (!verses.includes(ref)) verses.push(ref);
        currentVerse = ref;
        pending.push({ kind: 'verse', ref });
      } else if (a['unit'] === 'section') {
        // Paragraph divisions (samekh/pe) close the preceding text,
        // so they belong at the end of the current line — not pending
        // for the next token.
        const mark: InlineMark = { kind: 'section', subtype: a['subtype'] ?? 'section' };
        const last = currentLine?.tokens[currentLine.tokens.length - 1];
        if (last) last.marks.push(mark);
        else pending.push(mark);
      }
    } else {
      const name = m[1];
      const text = (m[2] ?? '').trim();
      if (!text) {
        pending = [];
        continue;
      }
      if (!currentLine) {
        currentLine = { n: '', tokens: [] };
        started = true;
      }
      let kind: Token['kind'] = 'w';
      if (name === 'pc') {
        const t = attrs(tag)['type'] ?? '';
        kind = t === 'paseq' ? 'paseq' : 'sof-pasuq';
      }
      currentLine.tokens.push({ text, kind, marks: pending, verse: currentVerse });
      pending = [];
    }
  }
  flushLine();
  if (started) columns.push(currentCol);
  return { title, graphicUrl, columns, verses };
}

export function abbreviateRange(range: string): string {
  let out = range;
  for (const [stem, abbr] of Object.entries(SBL_ABBREVIATIONS)) {
    out = out.split(stem).join(abbr);
    out = out.split(stem.replace(/_/g, ' ')).join(abbr);
  }
  return out;
}

export function folioSideLabel(folio: string): string {
  const side = folio.endsWith('A') ? 'recto' : folio.endsWith('B') ? 'verso' : '';
  return side ? `${folio} (${side})` : folio;
}

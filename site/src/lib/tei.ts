import { XMLParser } from 'fast-xml-parser';

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

type XmlAttrs = Record<string, string>;
interface OrderedNode {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [tag: string]: any;
  ':@'?: XmlAttrs;
}

const teiParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  trimValues: false,
  preserveOrder: true,
});

function nodeAttrs(node: OrderedNode): XmlAttrs {
  const raw = node[':@'] as XmlAttrs | undefined;
  if (!raw) return {};
  const out: XmlAttrs = {};
  for (const [k, v] of Object.entries(raw)) out[k] = String(v);
  return out;
}

function innerText(children: unknown[]): string {
  let s = '';
  for (const child of children as OrderedNode[]) {
    if (!child || typeof child !== 'object') continue;
    if ('#text' in child && typeof (child as Record<string, unknown>)['#text'] === 'string') {
      s += (child as Record<string, string>)['#text'];
    } else {
      for (const [key, value] of Object.entries(child)) {
        if (key === ':@' || key === '#text') continue;
        if (Array.isArray(value)) s += innerText(value as unknown[]);
      }
    }
  }
  return s;
}

function childrenOf(node: OrderedNode, tag: string): OrderedNode[] {
  const v = node[tag];
  return Array.isArray(v) ? (v as OrderedNode[]) : [];
}

function findFirst(nodes: OrderedNode[], tag: string): OrderedNode | null {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@' || key === '#text') continue;
      if (key === tag) return node;
      if (Array.isArray(value)) {
        const hit = findFirst(value as OrderedNode[], tag);
        if (hit) return hit;
      }
    }
  }
  return null;
}

function findEditionDiv(nodes: OrderedNode[]): OrderedNode | null {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@' || key === '#text') continue;
      if (key === 'div' && nodeAttrs(node)['type'] === 'edition') return node;
      if (Array.isArray(value)) {
        const hit = findEditionDiv(value as OrderedNode[]);
        if (hit) return hit;
      }
    }
  }
  return null;
}

interface EditionToken {
  tag: string;
  attrs: XmlAttrs;
  children: OrderedNode[];
}

const TOKEN_TAGS = new Set(['cb', 'lb', 'milestone', 'w', 'pc']);

function collectTokens(nodes: OrderedNode[], out: EditionToken[]): void {
  for (const node of nodes) {
    const attrs = nodeAttrs(node);
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@' || key === '#text' || key === '?xml') continue;
      if (!Array.isArray(value)) continue;
      const kids = value as OrderedNode[];
      if (TOKEN_TAGS.has(key)) {
        out.push({ tag: key, attrs, children: kids });
      } else {
        collectTokens(kids, out);
      }
    }
  }
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
  let ordered: OrderedNode[];
  try {
    ordered = teiParser.parse(xml) as OrderedNode[];
  } catch {
    return { title: 'Folio', graphicUrl: null, columns: [], verses: [] };
  }
  if (!Array.isArray(ordered)) return { title: 'Folio', graphicUrl: null, columns: [], verses: [] };

  const titleNode = findFirst(ordered, 'title');
  const title = titleNode ? innerText(childrenOf(titleNode, 'title')).trim() || 'Folio' : 'Folio';
  const graphicNode = findFirst(ordered, 'graphic');
  const graphicUrl = graphicNode ? (nodeAttrs(graphicNode)['url'] ?? null) : null;

  const editionDiv = findEditionDiv(ordered);
  const tokens: EditionToken[] = [];
  if (editionDiv) collectTokens(childrenOf(editionDiv, 'div'), tokens);

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

  for (const tok of tokens) {
    if (tok.tag === 'cb') {
      flushLine();
      if (started) columns.push(currentCol);
      currentCol = { n: tok.attrs['n'] ?? String(columns.length + 1), lines: [] };
      started = true;
    } else if (tok.tag === 'lb') {
      flushLine();
      currentLine = { n: tok.attrs['n'] ?? '', tokens: [] };
      started = true;
    } else if (tok.tag === 'milestone') {
      const a = tok.attrs;
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
      const text = innerText(tok.children).trim();
      if (!text) {
        pending = [];
        continue;
      }
      if (!currentLine) {
        currentLine = { n: '', tokens: [] };
        started = true;
      }
      let kind: Token['kind'] = 'w';
      if (tok.tag === 'pc') {
        const t = tok.attrs['type'] ?? '';
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

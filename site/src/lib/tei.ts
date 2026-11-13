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
  /** `erasure` is a `<del rend="erasure">`: writing the scribe erased. It is not verse text. */
  kind: 'w' | 'sof-pasuq' | 'paseq' | 'inverted-nun' | 'erasure';
  marks: InlineMark[];
  /** Always null for an erasure. */
  verse: string | null;
  /** Set when the token sits in a `<damageSpan>`: the agent of the damage (e.g. "tape"). The text is still verse text. */
  damage?: string;
  /** Erasure only: part of it cannot be read (a `<gap>`). `text` holds the part that can. */
  illegible?: boolean;
  /** Erasure only: its parts in TEI order, a string for readable text and null for a `<gap>`. */
  parts?: (string | null)[];
}

export interface TeiLine {
  n: string;
  tokens: Token[];
  /** Section marks on a line with no words (e.g. a lone pe line). */
  marks: SectionMark[];
}

export interface TeiColumn {
  n: string;
  lines: TeiLine[];
}

export interface RespPart {
  text?: string;
  /** Link target from a `<ptr>`; shown as a link, never from an email `ref`. */
  href?: string;
}

export interface Credit {
  id: string;
  resp: RespPart[];
  names: string[];
}

/** A zone segment in image pixels: `[ulx, uly, lrx, lry]`. */
export type ZoneSegment = [number, number, number, number];

export interface VerseZone {
  /** Masoretica recognition score for the verse, or null when the TEI has none. */
  cert: number | null;
  /** One segment per line that the verse crosses, in reading order. */
  segments: ZoneSegment[];
}

export interface Facsimile {
  /** Size of the surface in image pixels, or null when the TEI does not state it. */
  width: number | null;
  height: number | null;
  /** IIIF Image API service of the Archive.org graphic, which the zones use. */
  imageService: string | null;
  /** Zones keyed by verse reference, as in `FolioDoc.verses` (e.g. `Gen 34:12`). */
  zones: Record<string, VerseZone>;
}

export interface FolioDoc {
  title: string;
  credits: Credit[];
  /** Model that aligned the folio, from the ai-params feature structure. */
  model: string | null;
  graphicUrl: string | null;
  columns: TeiColumn[];
  verses: string[];
  facsimile: Facsimile;
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

// `del` is a token, not a container: the words in an erasure are not verse text.
// `damageSpan` and `anchor` are not tokens either: they mark a span of legible
// but damaged text (e.g. obscured by tape), and the words in it stay verse text.
const TOKEN_TAGS = new Set(['cb', 'lb', 'milestone', 'w', 'pc', 'del', 'damageSpan', 'anchor']);

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

/** An erasure's parts in order (text, or null for a gap), its readable text, and whether part of it cannot be read. */
function erasureContent(nodes: OrderedNode[]): { text: string; illegible: boolean; parts: (string | null)[] } {
  const parts: (string | null)[] = [];
  const walk = (list: OrderedNode[]) => {
    for (const node of list) {
      for (const [key, value] of Object.entries(node)) {
        if (key === ':@' || key === '#text' || !Array.isArray(value)) continue;
        const kids = value as OrderedNode[];
        if (key === 'gap') {
          if (parts[parts.length - 1] !== null) parts.push(null);
        } else if (key === 'w' || key === 'pc') {
          const word = innerText(kids).trim();
          if (!word) continue;
          const last = parts[parts.length - 1];
          if (typeof last !== 'string') parts.push(word);
          else parts[parts.length - 1] = key === 'pc' || last.endsWith('־') ? last + word : `${last} ${word}`;
        } else walk(kids);
      }
    }
  };
  walk(nodes);
  const text = parts.filter((p): p is string => p !== null).join(' ');
  return { text, illegible: parts.includes(null), parts };
}

function collectByTag(nodes: OrderedNode[], tag: string, out: OrderedNode[]): void {
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === ':@' || key === '#text') continue;
      if (key === tag) out.push(node);
      else if (Array.isArray(value)) collectByTag(value as OrderedNode[], tag, out);
    }
  }
}

/**
 * Read the titleStmt respStmts, skipping the project's own entry (the first).
 * Only names and resp text are kept: `persName/@ref` (often a mailto:) is dropped.
 */
function parseCredits(ordered: OrderedNode[]): Credit[] {
  const titleStmt = findFirst(ordered, 'titleStmt');
  if (!titleStmt) return [];
  const stmts: OrderedNode[] = [];
  collectByTag(childrenOf(titleStmt, 'titleStmt'), 'respStmt', stmts);
  return stmts
    .filter((n) => nodeAttrs(n)['id'] !== 'leningrad-codex-tei')
    .map((n) => {
      const kids = childrenOf(n, 'respStmt');
      const respNode = kids.find((k) => 'resp' in k);
      const resp: RespPart[] = [];
      for (const part of respNode ? childrenOf(respNode, 'resp') : []) {
        if ('#text' in part) {
          const text = String(part['#text']);
          if (text) resp.push({ text });
        } else if ('ptr' in part) {
          const href = nodeAttrs(part)['target'];
          if (href) resp.push({ href });
        }
      }
      const names = kids
        .filter((k) => 'persName' in k || 'name' in k || 'orgName' in k)
        .map((k) => innerText(Object.values(k).find(Array.isArray) as unknown[]).trim())
        .filter(Boolean);
      return { id: nodeAttrs(n)['id'] ?? '', resp, names };
    })
    .filter((c) => c.resp.length > 0 || c.names.length > 0);
}

function parseModel(ordered: OrderedNode[]): string | null {
  const fsNodes: OrderedNode[] = [];
  collectByTag(ordered, 'fs', fsNodes);
  for (const fs of fsNodes) {
    if (nodeAttrs(fs)['type'] !== 'ai-params') continue;
    for (const f of childrenOf(fs, 'fs')) {
      if ('f' in f && nodeAttrs(f)['name'] === 'model') {
        const value = innerText(childrenOf(f, 'f')).trim();
        if (value) return value;
      }
    }
  }
  return null;
}

const IIIF_FULL_SUFFIX = '/full/max/0/default.jpg';

function parseFacsimile(ordered: OrderedNode[]): Facsimile {
  const surface = findFirst(ordered, 'surface');
  const out: Facsimile = { width: null, height: null, imageService: null, zones: {} };
  if (!surface) return out;
  const attrs = nodeAttrs(surface);
  out.width = Number(attrs['lrx']) || null;
  out.height = Number(attrs['lry']) || null;
  for (const child of childrenOf(surface, 'surface')) {
    const a = nodeAttrs(child);
    if ('graphic' in child && (a['id'] ?? '').endsWith('-img-archive')) {
      const url = a['url'] ?? '';
      if (url.endsWith(IIIF_FULL_SUFFIX)) out.imageService = url.slice(0, -IIIF_FULL_SUFFIX.length);
    }
    if (!('zone' in child) || a['type'] !== 'verse') continue;
    const segments: ZoneSegment[] = [];
    for (const seg of childrenOf(child, 'zone')) {
      if (!('zone' in seg)) continue;
      const s = nodeAttrs(seg);
      const box = [s['ulx'], s['uly'], s['lrx'], s['lry']].map(Number);
      if (box.every(Number.isFinite)) segments.push(box as ZoneSegment);
    }
    const ref = formatRef((a['id'] ?? '').replace(/^f[^-]+-zone-/, ''));
    out.zones[ref] = { cert: a['cert'] ? Number(a['cert']) : null, segments };
  }
  return out;
}

const emptyDoc = (): FolioDoc => ({
  title: 'Folio',
  credits: [],
  model: null,
  graphicUrl: null,
  columns: [],
  verses: [],
  facsimile: { width: null, height: null, imageService: null, zones: {} },
});

export function parseFolioXml(xml: string): FolioDoc {
  let ordered: OrderedNode[];
  try {
    ordered = teiParser.parse(xml) as OrderedNode[];
  } catch {
    return emptyDoc();
  }
  if (!Array.isArray(ordered)) return emptyDoc();

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
  // Open damageSpan: the agent of the damage and the xml:id its closing anchor carries.
  let damageAgent: string | null = null;
  let damageEnd: string | null = null;

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
      currentLine = { n: tok.attrs['n'] ?? '', tokens: [], marks: [] };
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
        const mark: SectionMark = { kind: 'section', subtype: a['subtype'] ?? 'section' };
        // Not an erasure: it is not verse text, so the division belongs to the word before it.
        const last = currentLine?.tokens.findLast((t) => t.kind !== 'erasure');
        if (last) last.marks.push(mark);
        else if (currentLine) currentLine.marks.push(mark);
        else pending.push(mark);
      }
    } else if (tok.tag === 'damageSpan') {
      damageAgent = tok.attrs['agent'] ?? 'damage';
      damageEnd = (tok.attrs['spanTo'] ?? '').replace(/^#/, '') || null;
    } else if (tok.tag === 'anchor') {
      // removeNSPrefix drops the `xml:` on `xml:id`, so the attribute arrives as `id`.
      const anchorId = tok.attrs['xml:id'] ?? tok.attrs['id'];
      if (damageEnd && anchorId === damageEnd) {
        damageAgent = null;
        damageEnd = null;
      }
    } else if (tok.tag === 'del') {
      // An erasure takes no verse and no pending marks: a verse starts at its first real word.
      const { text, illegible, parts } = erasureContent(tok.children);
      if (!text && !illegible) continue;
      if (!currentLine) {
        currentLine = { n: '', tokens: [], marks: [] };
        started = true;
      }
      currentLine.tokens.push({ text, kind: 'erasure', marks: [], verse: null, illegible, parts });
    } else {
      const text = innerText(tok.children).trim();
      if (!text) {
        pending = [];
        continue;
      }
      if (!currentLine) {
        currentLine = { n: '', tokens: [], marks: [] };
        started = true;
      }
      let kind: Token['kind'] = 'w';
      if (tok.tag === 'pc') {
        const t = tok.attrs['type'] ?? '';
        kind = t === 'paseq' || t === 'inverted-nun' ? t : 'sof-pasuq';
      }
      const token: Token = { text, kind, marks: pending, verse: currentVerse };
      if (damageAgent) token.damage = damageAgent;
      currentLine.tokens.push(token);
      pending = [];
    }
  }
  flushLine();
  if (started) columns.push(currentCol);
  return {
    title,
    credits: parseCredits(ordered),
    model: parseModel(ordered),
    graphicUrl,
    columns,
    verses,
    facsimile: parseFacsimile(ordered),
  };
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

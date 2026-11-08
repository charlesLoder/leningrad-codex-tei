/** Loads folio sides, builds their page elements, and keeps only the ones near the reader. */
import { buildViewData, type FolioViewData } from '../folio-view.ts';
import { type FolioDoc, parseFolioXml } from '../tei.ts';
import { type Crop, cropUrl, type FolioLayout, justifySpacing, layoutFolio } from './layout.ts';
import type { BookView } from './view.ts';

export interface PageEntry {
  side: string;
  doc: FolioDoc;
  view: FolioViewData;
  layout: FolioLayout;
  element: HTMLElement;
  /** Whether any photograph can show yet: the small preview comes first. */
  photo: 'none' | 'loading' | 'ready' | 'missing';
  /** Settles when the preview has loaded or failed. */
  preview?: Promise<boolean>;
  fullAsked: boolean;
  images: HTMLImageElement[];
}

/** The IIIF server gives this size about three times faster than the sharp one. */
const PREVIEW_WIDTH = 500;
const FULL_WIDTH = 1100;

const pct = (share: number): string => `${(share * 100).toFixed(3)}%`;

function buildElement(side: string, layout: FolioLayout, size: { width: number; height: number }, solid: boolean): HTMLElement {
  const page = document.createElement('article');
  page.className = solid ? 'codex-page codex-page-solid' : 'codex-page';
  page.setAttribute('drawable', '');
  page.setAttribute('aria-label', `Folio ${side}`);
  page.dataset.side = side;
  page.dataset.face = side.endsWith('A') ? 'recto' : 'verso';
  page.lang = 'he';
  page.dir = 'rtl';
  page.style.width = `${size.width}px`;
  page.style.height = `${size.height}px`;
  const mark = document.createElement('span');
  mark.className = 'codex-foliation';
  mark.textContent = side;
  mark.setAttribute('aria-hidden', 'true');
  mark.lang = 'en';
  page.append(mark);
  for (const col of layout.columns) {
    const section = document.createElement('section');
    section.className = 'codex-col';
    section.setAttribute('aria-label', `Column ${col.n}`);
    section.style.left = pct(col.left);
    section.style.width = pct(col.right - col.left);
    const fontSize = col.pitch * size.height * 0.68;
    section.style.fontSize = `${fontSize.toFixed(2)}px`;
    for (const line of col.lines) {
      const row = document.createElement('div');
      row.className = 'codex-line';
      row.dataset.col = col.n;
      row.dataset.line = line.n;
      if (line.short) row.dataset.short = '';
      row.style.top = pct(line.y - col.pitch / 2);
      row.style.height = pct(col.pitch);
      const inner = document.createElement('span');
      inner.className = 'codex-he';
      inner.innerHTML = line.html || '&nbsp;';
      row.append(inner);
      section.append(row);
    }
    page.append(section);
  }
  return page;
}

/**
 * Each line fills its column as the scribe's line does. A line too long for the font
 * on this device is narrowed. All the reads come before all the writes, because a read
 * after a write makes the browser lay the page out again.
 */
function fitLines(page: HTMLElement): void {
  const rows: { inner: HTMLElement; short: boolean; natural: number; column: number; fontSize: number }[] = [];
  for (const section of page.querySelectorAll<HTMLElement>('.codex-col')) {
    const column = section.offsetWidth;
    const fontSize = parseFloat(section.style.fontSize);
    for (const row of section.querySelectorAll<HTMLElement>('.codex-line')) {
      const inner = row.firstElementChild as HTMLElement;
      rows.push({ inner, short: 'short' in row.dataset, natural: inner.offsetWidth, column, fontSize });
    }
  }
  for (const { inner, short, natural, column, fontSize } of rows) {
    if (!natural) continue;
    if (natural > column) {
      inner.style.transform = `scaleX(${(column / natural).toFixed(4)})`;
      continue;
    }
    const spaces = (inner.textContent?.match(/ /g) ?? []).length;
    const add = justifySpacing(natural, column, spaces, fontSize, short);
    if (add) inner.style.wordSpacing = `${add.toFixed(2)}px`;
  }
}

/** What the store needs to know about the leaves, so that its heavy work stays out of their way. */
export interface PageCalm {
  /** A leaf is in the air or in the hand. */
  busy(): boolean;
  /** The reader can see this side now, so it cannot wait. */
  showing(side: string): boolean;
}

/** How many pages may stay in memory while a leaf moves, as a held key can pass many. */
const MOST_PAGES_IN_FLIGHT = 14;

export class PageStore {
  private readonly entries = new Map<string, PageEntry>();
  private readonly loading = new Map<string, Promise<PageEntry | null>>();
  private retained = new Set<string>();
  private readonly waiting: { side: string; go: () => void }[] = [];
  private pumping = false;

  constructor(
    private readonly view: BookView,
    private readonly solidPages: boolean,
    private readonly calm: PageCalm,
    private readonly onPage: (entry: PageEntry) => void,
  ) {}

  get(side: string | null): PageEntry | undefined {
    return side ? this.entries.get(side) : undefined;
  }

  ensure(side: string | null): Promise<PageEntry | null> {
    if (!side) return Promise.resolve(null);
    const entry = this.entries.get(side);
    if (entry) return Promise.resolve(entry);
    const pending = this.loading.get(side);
    if (pending) return pending;
    const job = this.load(side).finally(() => this.loading.delete(side));
    this.loading.set(side, job);
    return job;
  }

  private async load(side: string): Promise<PageEntry | null> {
    try {
      const response = await fetch(`/edition/${side}.xml`);
      if (!response.ok) return null;
      const text = await response.text();
      await this.piece(side);
      if (!this.retained.has(side)) return null;
      const doc = parseFolioXml(text);
      await document.fonts?.ready;
      await this.piece(side);
      const layout = layoutFolio(doc);
      const element = buildElement(side, layout, this.view.pageSize, this.solidPages);
      await this.piece(side);
      if (!this.retained.has(side)) return null;
      this.view.addPage(side, element);
      fitLines(element);
      await this.piece(side);
      const entry: PageEntry = {
        side,
        doc,
        layout,
        element,
        photo: 'none',
        fullAsked: false,
        images: [],
        view: buildViewData(doc, { folio: side, version: '', manifest: null, prev: null, next: null }),
      };
      this.entries.set(side, entry);
      this.onPage(entry);
      return entry;
    } catch {
      return null;
    }
  }

  /**
   * Waits before the next piece of building a page. While a leaf moves, each frame gets
   * one piece, right after it is drawn, so that the piece has the time until the next
   * frame. A side that the reader can see goes first.
   */
  private piece(side: string): Promise<void> {
    return new Promise((go) => {
      if (!this.calm.busy()) {
        setTimeout(go, 0);
        return;
      }
      this.waiting.push({ side, go });
      this.pump();
    });
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    requestAnimationFrame(() =>
      setTimeout(() => {
        this.pumping = false;
        const seen = this.waiting.findIndex((job) => this.calm.showing(job.side));
        this.waiting.splice(Math.max(0, seen), 1)[0]?.go();
        if (this.waiting.length) this.pump();
      }, 0),
    );
  }

  /** Keep these sides, load the ones that are missing, and free the rest. */
  retain(sides: Iterable<string | null>): void {
    const keep = new Set<string>();
    for (const side of sides) if (side) keep.add(side);
    this.retained = keep;
    for (const side of keep) void this.ensure(side);
    // Freeing a page waits for the landing, which retains again, unless a long run of leaves has passed many.
    const busy = this.calm.busy();
    if (busy && this.entries.size <= MOST_PAGES_IN_FLIGHT) return;
    for (const [side, entry] of this.entries) {
      if (keep.has(side)) continue;
      for (const image of entry.images) image.src = '';
      this.view.removePage(side);
      this.entries.delete(side);
      if (busy) return;
    }
  }

  /**
   * Fetch a side's photograph. The IIIF server can take seconds, so this never holds
   * up the text. The preview comes first, and `full` then asks for the sharp one.
   */
  photo(side: string | null, onChange: () => void, full: boolean): void {
    const entry = this.get(side);
    if (!entry || entry.photo === 'missing') return;
    if (entry.photo === 'none') {
      if (!entry.doc.facsimile.imageService || !entry.layout.crop) {
        entry.photo = 'missing';
        onChange();
        return;
      }
      entry.photo = 'loading';
      entry.preview = this.fetchPhoto(entry, PREVIEW_WIDTH).then((ok) => {
        entry.photo = ok ? 'ready' : 'missing';
        onChange();
        return ok;
      });
    }
    if (full && !entry.fullAsked) {
      entry.fullAsked = true;
      void entry.preview?.then(async (ok) => {
        if (ok && (await this.fetchPhoto(entry, FULL_WIDTH))) onChange();
      });
    }
  }

  private fetchPhoto(entry: PageEntry, width: number): Promise<boolean> {
    return new Promise((resolve) => {
      const image = new Image();
      image.crossOrigin = 'anonymous';
      image.decoding = 'async';
      entry.images.push(image);
      const current = () => this.entries.get(entry.side) === entry;
      image.onload = async () => {
        // Decoded away from the main thread, so that the upload does not have to decode it.
        await image.decode().catch(() => {});
        if (current()) this.view.setPhoto(entry.side, image);
        resolve(current());
      };
      image.onerror = () => resolve(false);
      image.src = cropUrl(entry.doc.facsimile.imageService as string, entry.layout.crop as Crop, width);
    });
  }
}

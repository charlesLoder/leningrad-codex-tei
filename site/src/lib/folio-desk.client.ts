/**
 * Browser behavior of the folio page: one verse selection shared by the text and
 * the image, the views, the go-to search, and the keyboard.
 */
import { folioCitation } from './citation.ts';
import {
  chapterAndVerse,
  hashToKey,
  lineSummary,
  refKey,
  refToHash,
  searchFolios,
  verseNeighbors,
  type FolioViewData,
  type ViewVerse,
} from './folio-view.ts';
import { icons } from './icons.ts';
import { mountStage, type Stage } from './iiif-stage.ts';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T | null;
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      /* Private windows can refuse storage; the page still works. */
    }
  },
};

const data = JSON.parse($('#folio-data')?.textContent ?? '{}') as FolioViewData;
const verses = new Map(data.verses.map((v) => [v.ref, v]));
const desk = $('#desk') as HTMLElement;
const columns = $('.columns') as HTMLElement;
const plate = $('#facsimile') as HTMLElement;
const card = $('#verse-card') as HTMLElement;
const tip = $('#verse-tip') as HTMLElement;

const isWide = () => matchMedia('(min-width: 1200px)').matches;
const isPhone = () => matchMedia('(max-width: 759px)').matches;
const isPicking = () => document.body.classList.contains('picking');
const escapeText = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

/* ---------- Selection ---------- */
let hover: { ref: string; segment: number | null } | null = null;
let pinned: string | null = null;
let moreOpen = false;
let stage: Stage | null = null;

/** Line-level links need one zone segment per text line; otherwise the whole verse shows. */
const oneSegmentPerLine = (v: ViewVerse) => v.segments.length === v.lines.length;

function paint(): void {
  const active = hover?.ref ?? pinned;
  columns.querySelectorAll('.verse-run.on, .verse-run.pin, .verse-num.on, .verse-num.pin').forEach((n) => n.classList.remove('on', 'pin'));
  document.querySelectorAll('.tei-line.cur').forEach((n) => n.classList.remove('cur'));
  const runs = (ref: string) => columns.querySelectorAll(`:is(.verse-run, .verse-num)[data-verse="${CSS.escape(ref)}"]`);
  if (pinned) runs(pinned).forEach((n) => n.classList.add('pin'));
  if (active) runs(active).forEach((n) => n.classList.add('on'));

  let segment: number | null = null;
  const v = hover && verses.get(hover.ref);
  if (v && hover && hover.segment !== null && hover.segment >= 0 && oneSegmentPerLine(v)) {
    segment = hover.segment;
    const line = v.lines[segment];
    if (line) columns.querySelector(`.tei-line[data-col="${line[0]}"][data-line="${line[1]}"]`)?.classList.add('cur');
  }
  stage?.mark(active ?? null, pinned, segment);
}

function setHover(next: typeof hover): void {
  if (hover?.ref === next?.ref && hover?.segment === next?.segment) return;
  hover = next;
  paint();
}

function setPin(ref: string | null, opts: { scroll?: boolean } = {}): void {
  pinned = ref && verses.has(ref) ? ref : null;
  moreOpen = false;
  paint();
  renderCard();
  if (pinned) {
    if (opts.scroll !== false) scrollToVerse(pinned);
    if (currentView() !== 'text') stage?.showVerse(pinned);
  }
  try {
    history.replaceState(null, '', pinned ? `#${refToHash(pinned)}` : location.pathname + location.search);
  } catch {
    /* Some embedded views refuse history changes. */
  }
}

function scrollToVerse(ref: string): void {
  const run = columns.querySelector(`.verse-run[data-verse="${CSS.escape(ref)}"]`);
  if (!run || currentView() === 'image') return;
  if (isPhone()) showColumn(run.closest<HTMLElement>('.column'));
  run.closest('.tei-line')?.scrollIntoView({ block: 'nearest' });
}

function step(by: number): void {
  const list = data.verses;
  const i = list.findIndex((v) => v.ref === pinned);
  const next = i < 0 ? (by > 0 ? 0 : list.length - 1) : i + by;
  if (next >= 0 && next < list.length) setPin(list[next].ref);
}

/* ---------- Selected-verse card ---------- */
function cropsHtml(v: ViewVerse): string {
  if (!data.imageService) return '';
  const images = v.segments.map((s) => {
    const region = `${s[0]},${s[1]},${s[2] - s[0]},${s[3] - s[1]}`;
    return `<img src="${data.imageService}/${region}/,44/0/default.jpg" alt="" loading="lazy" />`;
  });
  return `<div class="verse-crops" role="img" aria-label="${escapeText(v.ref)} on the page image">${images.join('')}</div>`;
}

function renderCard(): void {
  const v = pinned ? verses.get(pinned) : null;
  card.hidden = !v;
  if (!v) {
    card.innerHTML = '';
    return;
  }
  const hasZone = v.segments.length > 0;
  const low = v.cert !== null && v.cert < 0.7;
  const q = 'class="quiet" type="button"';
  const facts = [
    hasZone && v.cert !== null
      ? `<span title="Masoretica handwriting recognition score for this verse">Zone score ${Math.round(v.cert * 100)}%</span>`
      : '',
    hasZone ? '' : '<span>No zone on the image</span>',
    hasZone && !oneSegmentPerLine(v)
      ? `<span title="The zone has ${v.segments.length} segments and the text has ${v.lines.length} lines">Whole verse only</span>`
      : '',
    ...verseNeighbors(data, v.ref).map(
      (n) => `<a class="quiet" href="/folio/${n.folio}/#${refToHash(v.ref)}">${n.label} ${n.folio}</a>`,
    ),
    hasZone && data.manifest && currentView() !== 'text' ? `<button ${q} data-act="zoom">Zoom to verse</button>` : '',
    `<button ${q} data-act="link">Copy link</button>`,
    `<button ${q} data-act="report">Report</button>`,
  ].join('');
  card.innerHTML = `
    ${currentView() === 'text' && !isWide() && hasZone ? cropsHtml(v) : ''}
    <div class="verse-card-row">
      <span class="verse-card-ref">${escapeText(v.ref)}</span>
      <span class="verse-card-where">${escapeText(lineSummary(v.lines))}</span>
      ${low ? '<span class="verse-card-warn" title="The zone may be in the wrong place">Check by eye</span>' : ''}
      <span class="verse-card-actions">
        <button ${q} data-act="next" aria-label="Next verse">${icons.chevronLeft}</button>
        <button ${q} data-act="prev" aria-label="Previous verse">${icons.chevronRight}</button>
        <button ${q} data-act="more" aria-expanded="${moreOpen}" aria-label="More about this verse">${icons.ellipsis}</button>
        <button ${q} data-act="clear" aria-label="Clear selection">${icons.x}</button>
      </span>
    </div>
    ${moreOpen ? `<div class="verse-card-more">${facts}</div>` : ''}`;
}

async function copy(button: HTMLElement, text: string): Promise<void> {
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = 'Copied';
  } catch {
    button.textContent = 'Copy failed';
  }
  setTimeout(() => {
    button.textContent = label;
  }, 1800);
}

card.addEventListener('click', (e) => {
  const button = (e.target as HTMLElement).closest<HTMLElement>('button[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  if (act === 'prev') step(-1);
  else if (act === 'next') step(1);
  else if (act === 'clear') setPin(null);
  else if (act === 'more') {
    moreOpen = !moreOpen;
    renderCard();
  } else if (act === 'zoom' && pinned) stage?.zoomToVerse(pinned);
  else if (act === 'link' && pinned) {
    void copy(button, `${location.origin}/folio/${data.folio}/#${refToHash(pinned)}`);
  } else if (act === 'report' && pinned) {
    document.dispatchEvent(new CustomEvent('feedback:open', { detail: { lines: verses.get(pinned)?.lines ?? [] } }));
  }
});

/* ---------- Text events ---------- */
columns.addEventListener('pointerover', (e) => {
  if (e.pointerType === 'touch' || isPicking()) return;
  const run = (e.target as HTMLElement).closest<HTMLElement>('.verse-run');
  const ref = run?.dataset.verse;
  if (!run || !ref) {
    setHover(null);
    tip.togglePopover(false);
    return;
  }
  const line = run.closest<HTMLElement>('.tei-line');
  const v = verses.get(ref);
  const segment = v?.lines.findIndex(([c, l]) => c === line?.dataset.col && l === line?.dataset.line) ?? -1;
  setHover({ ref, segment });
  if (pinned === ref || !line) {
    tip.togglePopover(false);
    return;
  }
  const r = (line.querySelector('.he') as HTMLElement).getBoundingClientRect();
  tip.textContent = chapterAndVerse(ref);
  tip.style.left = `${r.right + 4}px`;
  tip.style.top = `${r.top + r.height / 2}px`;
  tip.togglePopover(true);
});
columns.addEventListener('pointerleave', () => {
  setHover(null);
  tip.togglePopover(false);
});
columns.addEventListener('click', (e) => {
  if (isPicking()) return;
  const ref = (e.target as HTMLElement).closest<HTMLElement>('.verse-run')?.dataset.verse;
  if (ref) setPin(pinned === ref ? null : ref, { scroll: false });
});
// The two clicks before this event toggle the selection, so select again here.
columns.addEventListener('dblclick', (e) => {
  if (isPicking()) return;
  const ref = (e.target as HTMLElement).closest<HTMLElement>('.verse-run')?.dataset.verse;
  if (!ref) return;
  // A double click also selects a word; that highlight would hide the verse highlight.
  getSelection()?.removeAllRanges();
  setPin(ref, { scroll: false });
  zoomImageTo(ref);
});

/* ---------- Phone columns ---------- */
const pick = $('#column-pick');
const markColumn = (n: string | undefined) =>
  pick?.querySelectorAll<HTMLElement>('[data-col]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.col === n)));
function showColumn(col: HTMLElement | null | undefined, smooth = false): void {
  if (!col) return;
  columns.scrollBy({
    left: col.getBoundingClientRect().left - columns.getBoundingClientRect().left,
    behavior: smooth ? 'smooth' : 'auto',
  });
  markColumn(col.dataset.column);
}
pick?.addEventListener('click', (e) => {
  const n = (e.target as HTMLElement).closest<HTMLElement>('[data-col]')?.dataset.col;
  if (n) showColumn(columns.querySelector<HTMLElement>(`.column[data-column="${n}"]`), true);
});
columns.addEventListener(
  'scroll',
  () => {
    const r = columns.getBoundingClientRect();
    const middle = r.left + r.width / 2;
    const col = [...columns.querySelectorAll<HTMLElement>('.column')].find((c) => {
      const b = c.getBoundingClientRect();
      return b.left <= middle && b.right >= middle;
    });
    if (col) markColumn(col.dataset.column);
  },
  { passive: true },
);

/* ---------- Text size ---------- */
/** CSS sizes the text from the window height; only the widest line needs a measurement. */
function fitWidth(): void {
  columns.style.removeProperty('--fs-w');
  const size = parseFloat(getComputedStyle(columns).fontSize);
  let ratio = 0;
  columns.querySelectorAll<HTMLElement>('.he').forEach((he) => {
    const inner = he.firstElementChild;
    if (inner && he.clientWidth) ratio = Math.max(ratio, inner.getBoundingClientRect().width / he.clientWidth);
  });
  if (ratio) columns.style.setProperty('--fs-w', `${((size / ratio) * 0.98).toFixed(2)}px`);
}

/* ---------- Views ---------- */
type View = 'both' | 'text' | 'image';
let view: View = (store.get('folio-view') as View | null) ?? 'both';
const currentView = (): View => (view === 'both' && !isWide() ? 'text' : view);

function applyView(): void {
  const current = currentView();
  desk.dataset.view = current;
  // The accessible name stays "Page image"; aria-pressed alone carries the state.
  const toggle = $('#toggle-image');
  toggle?.setAttribute('aria-pressed', String(current !== 'text'));
  toggle?.setAttribute('title', current === 'text' ? 'Show page image' : 'Hide page image');
  const expand = $('#plate-expand');
  if (expand) expand.textContent = current === 'image' ? 'Collapse' : 'Expand';
  if (current !== 'text') void startStage();
  renderCard();
  requestAnimationFrame(fitWidth);
}
function setView(next: View): void {
  view = next;
  store.set('folio-view', next);
  applyView();
}

/** Show the verse large on the image, and open the image first when it is closed. */
function zoomImageTo(ref: string): void {
  if (!verses.get(ref)?.segments.length) return;
  if (currentView() === 'text') setView(isWide() ? 'both' : 'image');
  if (stage) stage.zoomToVerse(ref);
  else pendingZoom = ref;
}

let pendingZoom: string | null = null;
let stageStarted = false;
async function startStage(): Promise<void> {
  if (stageStarted) return;
  stageStarted = true;
  stage = await mountStage(plate, data, {
    onHover: (hit) => setHover(hit),
    onTap: (ref) => {
      if (ref) setPin(pinned === ref ? null : ref);
    },
  });
  paint();
  if (pendingZoom) stage?.zoomToVerse(pendingZoom);
  else if (pinned) stage?.showVerse(pinned);
  pendingZoom = null;
}

$('#toggle-image')?.addEventListener('click', () => {
  if (currentView() === 'text') setView(isWide() ? 'both' : 'image');
  else setView('text');
});
$('#plate-expand')?.addEventListener('click', () => setView(currentView() === 'image' ? 'both' : 'image'));
$('#plate-more')?.addEventListener('click', (e) => {
  const button = e.currentTarget as HTMLElement;
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  plate.querySelectorAll<HTMLElement>('[data-plate-extra]').forEach((n) => {
    n.hidden = !open;
  });
});

/* ---------- Verse numbers, menu ---------- */
const verseToggle = $('#toggle-verses');
function applyVerseNumbers(on: boolean): void {
  // Print styles key off this class so print follows the toggle.
  columns.classList.toggle('show-verses', on);
  verseToggle?.setAttribute('aria-pressed', String(on));
  verseToggle?.setAttribute('title', on ? 'Hide verse numbers' : 'Show verse numbers');
}
verseToggle?.addEventListener('click', () => {
  const on = verseToggle.getAttribute('aria-pressed') !== 'true';
  store.set('folio-verses', on ? '1' : '0');
  applyVerseNumbers(on);
});

const menu = $<HTMLDetailsElement>('#folio-menu');
const jump = $<HTMLDetailsElement>('#folio-jump');
document.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (menu && (!target.closest('#folio-menu') || target.closest('a, button'))) menu.open = false;
  if (jump && !target.closest('#folio-jump')) jump.open = false;
});
for (const id of ['#print-folio', '#print-folio-menu']) $(id)?.addEventListener('click', () => window.print());
$('#copy-folio-citation')?.addEventListener('click', (e) => {
  void copy(e.currentTarget as HTMLElement, folioCitation(data.folio, data.version));
});

/* ---------- Go to ---------- */
const gotoInput = $<HTMLInputElement>('#goto-input');
const gotoList = $('#goto-list');
let folioList: [string, string][] | null = null;
let firstHit: string | null = null;

async function loadFolioList(): Promise<[string, string][]> {
  folioList ??= (await (await fetch('/folios.json')).json()) as [string, string][];
  return folioList;
}
async function renderGoTo(): Promise<void> {
  if (!gotoInput || !gotoList) return;
  const query = gotoInput.value;
  gotoList.hidden = !query.trim();
  firstHit = null;
  if (!query.trim()) return;
  const hits = searchFolios(await loadFolioList(), query);
  if (gotoInput.value !== query) return;
  firstHit = hits[0]?.href ?? null;
  gotoList.innerHTML = hits.length
    ? hits
        .map(
          (h, i) =>
            `<li><a class="${i === 0 ? 'first' : ''}" href="${h.href}"><span>Folio ${h.folio}</span><small>${escapeText(h.range.replace(/_/g, ' '))}</small></a></li>`,
        )
        .join('')
    : '<li class="goto-none">No match. Try Exod 3:14 or 250A.</li>';
}
jump?.addEventListener('toggle', () => {
  if (jump.open) {
    gotoInput?.focus();
    void loadFolioList();
  }
});
gotoInput?.addEventListener('input', () => void renderGoTo());
gotoInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (firstHit) location.assign(firstHit);
  }
  if (e.key === 'Escape' && jump) jump.open = false;
});

/* ---------- Keyboard ---------- */
document.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (e.metaKey || e.ctrlKey || e.altKey || isPicking()) return;
  if (target.closest('input, select, textarea, dialog, triiiceratops-viewer')) return;
  const follow = (rel: string) => document.querySelector<HTMLAnchorElement>(`a[rel="${rel}"]`)?.click();
  // The codex reads right to left, so the next page is to the left.
  if (e.key === 'ArrowLeft') follow('next');
  else if (e.key === 'ArrowRight') follow('prev');
  else if (e.key === 'j') step(1);
  else if (e.key === 'k') step(-1);
  else if (e.key === 'Escape') {
    if (menu) menu.open = false;
    if (jump) jump.open = false;
    setPin(null);
  } else if (e.key === '/' && jump) {
    e.preventDefault();
    jump.open = true;
  } else if (e.key === 'i') $('#toggle-image')?.click();
  else if (e.key === 'v') verseToggle?.click();
});

/* ---------- Start ---------- */
function routeHash(): void {
  const key = hashToKey(location.hash);
  const match = key === null ? null : (data.verses.find((v) => refKey(v.ref) === key)?.ref ?? null);
  if (match !== pinned) setPin(match);
}

applyVerseNumbers(store.get('folio-verses') === '1');
applyView();
routeHash();
addEventListener('hashchange', routeHash);
matchMedia('(min-width: 1200px)').addEventListener('change', applyView);
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  // Only width changes the measurement; the text's own height must not refire this.
  if (entry.contentRect.width === lastWidth) return;
  lastWidth = entry.contentRect.width;
  fitWidth();
}).observe(desk);
void document.fonts?.ready.then(fitWidth);

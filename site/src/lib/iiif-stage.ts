/**
 * The page image: every call to the triiiceratops viewer lives here.
 *
 * Its built-in controls and annotation shapes stay off. It only paints the image;
 * this module draws the verse zones in its own overlay, because the viewer has no
 * setting to style a single line of a verse. The viewer is a work in progress, so
 * keep it behind this module and pin its version.
 */
import type { FolioViewData, ViewVerse } from './folio-view.ts';
import type { ZoneSegment } from './tei.ts';

type Box = { x: number; y: number; width: number; height: number };
type Point = { x: number; y: number };

/** The part of the viewer's state that this page uses. */
interface ViewerState {
  rendererReady: boolean;
  canvasId: string | null;
  setAllAnnotationsVisible(visible: boolean): void;
  fitBounds(box: Box): void;
  fitCanvas(): void;
  panTo(point: Point): void;
  zoomIn(): void;
  zoomOut(): void;
  canvasToScreen(point: Point): Point | null;
  screenToCanvas(point: Point): Point | null;
  subscribeFrame(listener: () => void): () => void;
  subscribeSurfaceTap(listener: (point: Point) => void): () => void;
  subscribe(listener: () => void): () => void;
}

interface ViewerElement extends HTMLElement {
  viewerState?: ViewerState;
  config: unknown;
  initialCanvasRegion: Box | undefined;
}

export interface StageEvents {
  onHover(hit: { ref: string; segment: number } | null): void;
  onTap(ref: string | null): void;
}

export interface Stage {
  mark(active: string | null, pinned: string | null, segment: number | null): void;
  showVerse(ref: string): void;
  zoomToVerse(ref: string): void;
}

const SVG = 'http://www.w3.org/2000/svg';
const NO_CHROME = {
  showToggle: false,
  showCanvasNav: false,
  showZoomControls: false,
  toolbarOpen: false,
  transparentBackground: true,
  toolbar: {
    showSearch: false,
    showGallery: false,
    showAnnotations: false,
    showFullscreen: false,
    showInfo: false,
    showViewingMode: false,
    showStructures: false,
    showLocalePicker: false,
    showCollection: false,
  },
  information: { showButton: false },
  annotations: { open: false },
  gallery: { open: false },
};

const toBox = ([x, y, width, height]: [number, number, number, number]): Box => ({ x, y, width, height });

function verseBox(v: ViewVerse): Box {
  const left = Math.min(...v.segments.map((s) => s[0]));
  const top = Math.min(...v.segments.map((s) => s[1]));
  return {
    x: left,
    y: top,
    width: Math.max(...v.segments.map((s) => s[2])) - left,
    height: Math.max(...v.segments.map((s) => s[3])) - top,
  };
}

function placeRect(rect: SVGRectElement, s: ZoneSegment): void {
  rect.setAttribute('x', String(s[0]));
  rect.setAttribute('y', String(s[1]));
  rect.setAttribute('width', String(s[2] - s[0]));
  rect.setAttribute('height', String(s[3] - s[1]));
}

const contains = (s: ZoneSegment, p: Point): boolean => p.x >= s[0] && p.x <= s[2] && p.y >= s[1] && p.y <= s[3];

function waitFor(ready: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => (ready() ? resolve() : requestAnimationFrame(tick));
    tick();
  });
}

export async function mountStage(plate: HTMLElement, data: FolioViewData, events: StageEvents): Promise<Stage | null> {
  const viewer = plate.querySelector('triiiceratops-viewer') as ViewerElement | null;
  const overlay = plate.querySelector('.plate-zones') as SVGSVGElement | null;
  const mask = plate.querySelector('.plate-mask') as HTMLElement | null;
  if (!viewer || !overlay || !mask || !data.manifest || !data.width || !data.height) return null;

  await Promise.all([import('triiiceratops/element/register'), import('triiiceratops/style.css')]);
  viewer.config = NO_CHROME;
  if (data.leaf) viewer.initialCanvasRegion = toBox(data.leaf);
  viewer.setAttribute('manifest-id', data.manifest);

  await waitFor(() => Boolean(viewer.viewerState));
  const state = viewer.viewerState as ViewerState;
  await waitFor(() => state.rendererReady && Boolean(state.canvasId));
  state.setAllAnnotationsVisible(false);
  plate.dataset.ready = '';

  const width = data.width;
  const height = data.height;
  const verses = data.verses.filter((v) => v.segments.length > 0);

  // Zones
  const layer = document.createElementNS(SVG, 'g');
  for (const v of verses) {
    const group = document.createElementNS(SVG, 'g');
    group.classList.add('zone');
    group.dataset.verse = v.ref;
    for (const s of v.segments) {
      const rect = document.createElementNS(SVG, 'rect');
      placeRect(rect, s);
      group.append(rect);
    }
    layer.append(group);
  }
  const cur = document.createElementNS(SVG, 'rect');
  cur.classList.add('zone-cur');
  cur.style.display = 'none';
  layer.append(cur);
  overlay.append(layer);

  let showRuler = false;
  const draw = () => {
    const origin = state.canvasToScreen({ x: 0, y: 0 });
    const end = state.canvasToScreen({ x: width, y: height });
    if (!origin || !end) return;
    const scale = (end.x - origin.x) / width;
    layer.setAttribute('transform', `translate(${origin.x} ${origin.y}) scale(${scale})`);
    if (data.leaf && !showRuler) {
      const [x, y, w, h] = data.leaf;
      mask.hidden = false;
      mask.style.transform = `translate(${origin.x + x * scale}px, ${origin.y + y * scale}px)`;
      mask.style.width = `${w * scale}px`;
      mask.style.height = `${h * scale}px`;
    } else {
      mask.hidden = true;
    }
  };

  type Mode = 'leaf' | 'whole' | 'verse' | 'free';
  let mode: Mode = 'leaf';
  let framedVerse: ViewVerse | null = null;
  const frameVerse = (v: ViewVerse) => {
    const box = verseBox(v);
    const pad = Math.max(box.width, box.height) * 0.14;
    state.fitBounds({ x: box.x - pad, y: box.y - pad, width: box.width + 2 * pad, height: box.height + 2 * pad });
  };
  const fitLeaf = () => (data.leaf ? state.fitBounds(toBox(data.leaf)) : state.fitCanvas());
  const refit = () => {
    if (mode === 'leaf') fitLeaf();
    else if (mode === 'whole') state.fitCanvas();
    else if (mode === 'verse' && framedVerse) frameVerse(framedVerse);
    draw();
  };

  state.subscribeFrame(draw);
  new ResizeObserver(refit).observe(plate);
  refit();

  // Pointer to zone
  const hitAt = (screen: Point): { ref: string; segment: number } | null => {
    const point = state.screenToCanvas(screen);
    if (!point) return null;
    for (const v of verses) {
      const segment = v.segments.findIndex((s) => contains(s, point));
      if (segment >= 0) return { ref: v.ref, segment };
    }
    return null;
  };
  let hovered: string | null = null;
  viewer.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'touch' || e.buttons) return;
    const r = viewer.getBoundingClientRect();
    const hit = hitAt({ x: e.clientX - r.left, y: e.clientY - r.top });
    const key = hit ? `${hit.ref}|${hit.segment}` : null;
    if (key === hovered) return;
    hovered = key;
    viewer.style.cursor = hit ? 'pointer' : '';
    events.onHover(hit);
  });
  viewer.addEventListener('pointerleave', () => {
    hovered = null;
    events.onHover(null);
  });
  state.subscribeSurfaceTap((p) => events.onTap(hitAt(p)?.ref ?? null));

  // Controls
  const button = (id: string) => plate.querySelector(`#${id}`) as HTMLButtonElement | null;
  button('plate-in')?.addEventListener('click', () => {
    mode = 'free';
    state.zoomIn();
  });
  button('plate-out')?.addEventListener('click', () => {
    mode = 'free';
    state.zoomOut();
  });
  button('plate-fit')?.addEventListener('click', () => {
    mode = 'leaf';
    showRuler = false;
    fitLeaf();
    draw();
  });
  button('plate-whole')?.addEventListener('click', () => {
    mode = 'whole';
    showRuler = true;
    state.fitCanvas();
    draw();
  });
  button('plate-all')?.addEventListener('click', (e) => {
    const on = (e.currentTarget as HTMLElement).getAttribute('aria-pressed') !== 'true';
    (e.currentTarget as HTMLElement).setAttribute('aria-pressed', String(on));
    plate.classList.toggle('show-all-zones', on);
  });

  const find = (ref: string) => verses.find((v) => v.ref === ref) ?? null;
  return {
    mark(active, pinned, segment) {
      for (const group of layer.querySelectorAll<SVGGElement>('g.zone')) {
        const ref = group.dataset.verse;
        group.classList.toggle('on', ref === active);
        group.classList.toggle('pin', ref === pinned);
      }
      const box = active && segment !== null ? find(active)?.segments[segment] : null;
      cur.style.display = box ? '' : 'none';
      if (box) placeRect(cur, box);
    },
    showVerse(ref) {
      const v = find(ref);
      if (!v) return;
      const box = verseBox(v);
      const a = state.canvasToScreen({ x: box.x, y: box.y });
      const b = state.canvasToScreen({ x: box.x + box.width, y: box.y + box.height });
      const r = viewer.getBoundingClientRect();
      if (!a || !b || (a.x >= 0 && a.y >= 0 && b.x <= r.width && b.y <= r.height)) return;
      mode = 'free';
      state.panTo({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
    },
    zoomToVerse(ref) {
      const v = find(ref);
      if (!v) return;
      mode = 'verse';
      framedVerse = v;
      frameVerse(v);
    },
  };
}

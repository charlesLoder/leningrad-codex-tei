/**
 * The controller of the book at `/codex/`: which leaves are in the air, where the
 * camera is, and the controls around the stage. A view draws what it is told.
 */
import { abbreviateRange } from '../tei.ts';
import { hashToKey, lineSummary, refKey, refToHash, searchFolios } from '../folio-view.ts';
import { bookAt, type BookSpan, bookSpans, type Opening, openingAt, openingOfSide, openingRange, riffleSteps } from './book.ts';
import { CssView } from './css-view.ts';
import { GlView, supportsDrawableWebGL } from './gl-view.ts';
import { verseText } from './layout.ts';
import { clamp, type Flight, flightAt, leafAngleForX, PAGE_W, PAGE_Z, planFlight, type Pose, REST_PITCH } from './math.ts';
import { PageStore } from './page-store.ts';
import { folioHrefToRoute, parseRoute } from './route.ts';
import type { BookView, Scene, SceneLeaf, ViewMode } from './view.ts';

interface Leaf extends SceneLeaf {
  from: number;
  to: number;
  dir: 1 | -1;
  v: number;
  /** Where it is going. In the hand, this is the angle under the pointer. */
  target: number;
  /** The path to the target, or null when it stays where it is. */
  flight: Flight | null;
  /** The seconds that a whole turn takes. */
  pace: number;
  gripTarget: number;
  /** Seconds to wait before it moves, so the leaves of a riffle follow each other. */
  delay: number;
  underLeft: string | null;
  underRight: string | null;
  /** The hand holds it, so the pointer sets its angle. */
  held: boolean;
  /** Not yet turned for good: a peel at a corner, or a leaf in the hand. */
  pending: boolean;
}

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector(selector) as T;
const stage = $('#codex-stage');
const hud = $('#codex-hud');
const live = $('#codex-live');
const card = $('#codex-card');
const cardText = $('#codex-card-text');
const cardCopy = $<HTMLButtonElement>('#codex-card-copy');
const cardLink = $<HTMLAnchorElement>('#codex-card-link');
const note = $('#codex-note');
const scrub = $<HTMLInputElement>('#codex-scrub');
const scrubLabel = $('#codex-scrub-label');
const booksStrip = $('#codex-books');
const hint = $('#codex-hint');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** How far a leaf lifts when the pointer rests on its edge. */
const PEEL = 0.028;
const peelAngle = (dir: 1 | -1): number => (dir > 0 ? PEEL : 1 - PEEL);

function createView(): { view: BookView; plain: boolean } {
  const forced = new URLSearchParams(location.search).get('renderer');
  if (forced !== 'css' && supportsDrawableWebGL()) {
    try {
      return { view: new GlView(stage), plain: false };
    } catch (error) {
      // No WebGL2 here, or a driver refused a shader. The plain book still works.
      console.warn('The 3D book could not start, so the plain book is shown.', error);
    }
  }
  return { view: new CssView(stage), plain: true };
}

const { view, plain } = createView();
const surface = view.surface;
const store = new PageStore(view, plain, {
  busy: () => leaves.length > 0,
  showing: (side) => {
    const resting = restingSides();
    return side === resting.left || side === resting.right || leaves.some((l) => side === l.front || side === l.back);
  },
}, () => {
  applyVerseClasses();
  if (mode !== 'text') requestPhotos();
  schedule();
});

let list: [string, string][] = [];
let known = new Set<string>();
let ranges = new Map<string, string>();
let spans: BookSpan[] = [];
let first = 1;
let last = 1;
/** Where the reader is going: includes leaves still in the air. */
let opening = 1;
/** The opening under all leaves in the air. */
let landed = 1;
let leaves: Leaf[] = [];
let held: Leaf | null = null;
let mode: ViewMode = 'text';
let pinned: string | null = null;
let hovered: string | null = null;
let selectionText = '';
let focusSide: 'left' | 'right' = 'right';

/* ---------- Camera ---------- */

let zoom = 1;
let panX = 0;
let panY = 0;
let orbitYaw = 0;
let orbitPitch = REST_PITCH;
let insetBottom = 0;
let pose: Pose = { x: 0, y: 0, z: 0.1, dist: 3, yaw: 0, pitch: REST_PITCH };
let lens: { x: number; y: number } | null = null;

const isNarrow = (): boolean => stage.clientWidth / Math.max(1, stage.clientHeight) < 0.95;

function targetPose(): Pose {
  const narrow = isNarrow();
  const dist = view.fit(narrow, insetBottom) / zoom;
  // Closer in, the book turns to face the reader, because text at an angle is harder to read.
  const flatten = clamp((zoom - 1) / 1.1, 0, 1);
  return {
    x: panX + (narrow ? (focusSide === 'left' ? -PAGE_W / 2 : PAGE_W / 2) : 0),
    y: panY,
    z: PAGE_Z,
    dist,
    yaw: orbitYaw,
    pitch: view.canOrbit ? orbitPitch * (1 - flatten * flatten * (3 - 2 * flatten)) : 0,
  };
}

function setZoom(next: number, anchor?: { x: number; y: number }): void {
  const before = anchor ? view.worldAt(anchor.x, anchor.y) : null;
  const old = zoom;
  zoom = clamp(next, 1, 7);
  if (before && anchor && zoom !== old) {
    // Hold the point under the pointer still while the distance changes.
    const keep = 1 - old / zoom;
    panX += (before.x - pose.x) * keep;
    panY += (before.y - pose.y) * keep;
  }
  if (zoom === 1) {
    panX = 0;
    panY = 0;
  }
  clampPan();
  schedule();
}

function clampPan(): void {
  panX = clamp(panX, -PAGE_W, PAGE_W);
  panY = clamp(panY, -0.5, 0.5);
}

function resetCamera(): void {
  zoom = 1;
  panX = 0;
  panY = 0;
  orbitYaw = 0;
  orbitPitch = REST_PITCH;
  schedule();
}

/* ---------- Leaves ---------- */

const openingOf = (n: number): Opening => openingAt(n, known);
/** The way the reader last went. */
let travel: 1 | -1 = 1;

function currentProgress(): number {
  let at = landed;
  for (const leaf of leaves) {
    const share = leaf.dir > 0 ? leaf.t : 1 - leaf.t;
    at += (leaf.to - leaf.from) * share;
  }
  return last === first ? 0 : (at - first) / (last - first);
}

/** What lies under the leaves in the air. */
function restingSides(): { left: string | null; right: string | null } {
  if (leaves.length === 0) {
    const here = openingOf(opening);
    return { left: here.left, right: here.right };
  }
  const oldest = leaves[0];
  const newest = leaves[leaves.length - 1];
  return oldest.dir > 0 ? { left: newest.underLeft, right: oldest.underRight } : { left: oldest.underLeft, right: newest.underRight };
}

function snapLeaves(): void {
  for (const leaf of leaves) if (!leaf.pending) landed = leaf.to;
  leaves = [];
  held = null;
}

const TURN_SECONDS = 1.05;
/** A turn the reader asks for leaves at this share of its average speed, so it answers at once. */
const LAUNCH = 0.7;
const RIFFLE_SECONDS = 0.5;

/** Sends a leaf on its way from where it is, at the speed it has. */
function send(leaf: Leaf, target: number, launch = 0): void {
  leaf.target = target;
  leaf.flight = planFlight(leaf.t, leaf.v, target, leaf.pace, launch);
}

function makeLeaf(from: number, to: number, dir: 1 | -1, front: string | null, back: string | null, under: { left: string | null; right: string | null }): Leaf {
  const start = dir > 0 ? 0 : 1;
  return {
    front,
    back,
    t: start,
    v: 0,
    target: 1 - start,
    flight: planFlight(start, 0, 1 - start, TURN_SECONDS, LAUNCH),
    pace: TURN_SECONDS,
    grip: 0,
    gripTarget: 0,
    delay: 0,
    from,
    to,
    dir,
    underLeft: under.left,
    underRight: under.right,
    held: false,
    pending: false,
  };
}

function leafFor(dir: 1 | -1): Leaf | null {
  const to = opening + dir;
  if (to < first || to > last) return null;
  const here = openingOf(opening);
  const there = openingOf(to);
  return dir > 0
    ? makeLeaf(opening, to, 1, here.left, there.right, { left: there.left, right: here.right })
    : makeLeaf(opening, to, -1, there.left, here.right, { left: here.left, right: there.right });
}

/** One leaf over, by key or button. Quick presses send several leaves into the air. */
function turn(dir: 1 | -1): void {
  if (reducedMotion) {
    const to = opening + dir;
    if (to < first || to > last) return;
    opening = to;
    landed = to;
    afterMove();
    return;
  }
  travel = dir;
  // A leaf that the pointer has peeled carries on from where it is.
  if (held?.dir === dir) return releaseHeld(true);
  if (held) releaseHeld(false);
  const newest = leaves.at(-1);
  // The other key sends the last leaf back the way it came, and the first key sends it on again.
  if (newest && !newest.pending && newest.dir !== dir) {
    newest.pending = true;
    send(newest, newest.dir > 0 ? 0 : 1);
    opening = newest.from;
    return afterMove();
  }
  if (newest?.pending && newest.dir === dir) {
    newest.pending = false;
    send(newest, dir > 0 ? 1 : 0, LAUNCH);
    opening = newest.to;
    return afterMove();
  }
  if (leaves.some((l) => l.dir !== dir || l.pending)) snapLeaves();
  const leaf = leafFor(dir);
  if (!leaf) return;
  leaves.push(leaf);
  opening = leaf.to;
  afterMove();
}

/** A held key repeats faster than leaves can look like leaves, or than pages can be ready. */
const REPEAT_GAP = 220;
let lastRepeat = 0;

function repeatStep(event: KeyboardEvent, dir: 1 | -1): void {
  if (event.repeat && event.timeStamp - lastRepeat < REPEAT_GAP) return;
  lastRepeat = event.timeStamp;
  step(dir);
}

/** On a narrow screen one page shows at a time, so a step may only move the camera. */
function step(dir: 1 | -1): void {
  if (isNarrow()) {
    if (dir > 0 && focusSide === 'right') {
      focusSide = 'left';
      return schedule();
    }
    if (dir < 0 && focusSide === 'left') {
      focusSide = 'right';
      return schedule();
    }
    if ((dir > 0 && opening < last) || (dir < 0 && opening > first)) focusSide = dir > 0 ? 'right' : 'left';
  }
  turn(dir);
}

/** A long way: leaves riffle past, and the ones between are blank to the eye. */
async function jumpTo(target: number): Promise<void> {
  const to = clamp(target, first, last);
  if (to === opening) return;
  if (Math.abs(to - opening) === 1) return turn(to > opening ? 1 : -1);
  const dest = openingOf(to);
  store.retain([...neighborSides(opening), dest.left, dest.right]);
  if (reducedMotion) {
    snapLeaves();
    opening = to;
    landed = to;
    afterMove();
    return;
  }
  await Promise.race([Promise.all([store.ensure(dest.left), store.ensure(dest.right)]), new Promise((r) => setTimeout(r, 1800))]);
  snapLeaves();
  const here = openingOf(opening);
  const steps = riffleSteps(opening, to);
  const dir: 1 | -1 = to > opening ? 1 : -1;
  let from = opening;
  steps.forEach((stop, i) => {
    const firstLeaf = i === 0;
    const lastLeaf = i === steps.length - 1;
    const front = dir > 0 ? (firstLeaf ? here.left : null) : lastLeaf ? dest.left : null;
    const back = dir > 0 ? (lastLeaf ? dest.right : null) : firstLeaf ? here.right : null;
    const under = dir > 0 ? { left: dest.left, right: here.right } : { left: here.left, right: dest.right };
    const leaf = makeLeaf(from, stop, dir, front, back, under);
    leaf.pace = RIFFLE_SECONDS;
    leaf.flight = planFlight(leaf.t, 0, leaf.target, RIFFLE_SECONDS, LAUNCH);
    leaf.delay = i * 0.055;
    leaves.push(leaf);
    from = stop;
  });
  opening = to;
  afterMove();
}

function neighborSides(n: number): (string | null)[] {
  const out: (string | null)[] = [];
  for (const k of [n - 1, n, n + 1]) {
    if (k < first || k > last) continue;
    const o = openingOf(k);
    out.push(o.left, o.right);
  }
  return out;
}

/* ---------- The leaf in the hand ---------- */

function holdLeaf(dir: 1 | -1, v: number): Leaf | null {
  if (held?.dir === dir) return held;
  if (held) dropPeel();
  if (leaves.length) {
    const reusable = leaves.length === 1 && leaves[0].pending && leaves[0].dir === dir ? leaves[0] : null;
    if (reusable) {
      held = reusable;
      return held;
    }
    // Leaves already going the same way stay in the air, and this one joins them.
    if (leaves.some((l) => l.pending || l.dir !== dir)) snapLeaves();
  }
  const leaf = leafFor(dir);
  if (!leaf) return null;
  leaf.pending = true;
  leaf.grip = leaf.gripTarget = (0.5 - v) * 2 * dir;
  leaf.target = leaf.t;
  leaf.flight = null;
  leaves.push(leaf);
  held = leaf;
  store.retain(sceneSides());
  return leaf;
}

/** A leaf left at a corner falls back. */
function dropPeel(): void {
  if (!held) return;
  held.held = false;
  send(held, held.dir > 0 ? 0 : 1);
  held = null;
  schedule();
}

function peel(dir: 1 | -1, v: number): void {
  const leaf = holdLeaf(dir, v);
  if (!leaf) return;
  if (leaf.target !== peelAngle(dir)) send(leaf, peelAngle(dir));
  leaf.gripTarget = (0.5 - v) * 2 * dir;
  schedule();
}

function releaseHeld(commit: boolean): void {
  const leaf = held;
  held = null;
  if (!leaf) return;
  leaf.held = false;
  if (commit) {
    leaf.pending = false;
    send(leaf, leaf.dir > 0 ? 1 : 0, LAUNCH);
    opening = leaf.to;
    afterMove();
  } else {
    send(leaf, leaf.dir > 0 ? 0 : 1);
  }
  schedule();
}

/** A slow frame pauses the leaves for a moment, because a jump in their path shows more. */
const LONGEST_STEP = 1 / 30;
/** How fast a leaf in the hand catches the pointer, which also takes out the shake of the hand. */
const HAND_RATE = 26;
const GRIP_RATE = 12;

function stepLeaves(dt: number): void {
  const landedNow: Leaf[] = [];
  const step = Math.min(dt, LONGEST_STEP);
  for (const leaf of leaves) {
    leaf.grip = approach(leaf.grip, leaf.gripTarget, 1 - Math.exp(-step * GRIP_RATE));
    if (leaf.held) {
      const before = leaf.t;
      leaf.t = approach(leaf.t, leaf.target, 1 - Math.exp(-step * HAND_RATE));
      leaf.v = (leaf.t - before) / Math.max(step, 0.001);
      continue;
    }
    if (leaf.delay > 0) {
      leaf.delay -= step;
      continue;
    }
    if (!leaf.flight) continue;
    leaf.flight.elapsed += step;
    const now = flightAt(leaf.flight);
    leaf.t = now.t;
    leaf.v = now.v;
    if (leaf.flight.elapsed >= leaf.flight.seconds) {
      leaf.flight = null;
      leaf.t = leaf.target;
      leaf.v = 0;
      if (leaf.target !== peelAngle(leaf.dir)) landedNow.push(leaf);
    }
  }
  for (const leaf of landedNow) {
    leaves.splice(leaves.indexOf(leaf), 1);
    if (!leaf.pending) landed = leaf.to;
  }
  if (landedNow.length) store.retain(sceneSides());
}

function sceneSides(): (string | null)[] {
  const out = [...neighborSides(opening)];
  // One more opening ahead, so that a run of turns finds its pages ready.
  const ahead = opening + travel * 2;
  if (ahead >= first && ahead <= last) {
    const o = openingOf(ahead);
    out.push(o.left, o.right);
  }
  for (const leaf of leaves) out.push(leaf.front, leaf.back, leaf.underLeft, leaf.underRight);
  return out;
}

/* ---------- Frames ---------- */

/** `?slow=4` in the URL plays every movement four times slower, to look at it closely. */
const SLOW_MOTION = clamp(Number(new URLSearchParams(location.search).get('slow')) || 1, 1, 20);

let frameId = 0;
let lastFrame = 0;
let intro = !reducedMotion;

function schedule(): void {
  if (!frameId) frameId = requestAnimationFrame(frame);
}

function approach(current: number, target: number, rate: number): number {
  return current + (target - current) * rate;
}

function frame(now: number): void {
  frameId = 0;
  // A long gap, such as a hidden tab, must not throw the leaves across the book.
  const dt = Math.min(0.25, lastFrame && now - lastFrame < 500 ? (now - lastFrame) / 1000 : 0.016) / SLOW_MOTION;
  lastFrame = now;
  stepLeaves(dt);

  const goal = targetPose();
  const rate = reducedMotion ? 1 : 1 - Math.exp(-dt * (intro ? 2.6 : 9));
  const moved =
    Math.abs(goal.x - pose.x) + Math.abs(goal.y - pose.y) + Math.abs(goal.z - pose.z) + Math.abs(goal.yaw - pose.yaw) + Math.abs(goal.pitch - pose.pitch) + Math.abs(goal.dist - pose.dist) / goal.dist;
  if (moved < 0.0004) {
    pose = goal;
    intro = false;
  } else {
    pose = {
      x: approach(pose.x, goal.x, rate),
      y: approach(pose.y, goal.y, rate),
      z: approach(pose.z, goal.z, rate),
      dist: approach(pose.dist, goal.dist, rate),
      yaw: approach(pose.yaw, goal.yaw, rate),
      pitch: approach(pose.pitch, goal.pitch, rate),
    };
  }

  const sides = restingSides();
  const scene: Scene = { ...sides, leaves, progress: currentProgress(), pose, mode, lens, insetBottom, dt };
  view.render(scene);
  showPanCursor();
  if (leaves.length || moved >= 0.0004 || view.animating) schedule();
  // With nothing left to draw, the time until the next frame says nothing about motion.
  else lastFrame = 0;
}
view.onChange = schedule;

/* ---------- After every move ---------- */

function afterMove(): void {
  getSelection()?.removeAllRanges();
  setPin(null);
  store.retain(sceneSides());
  showOpening();
  if (mode !== 'text') requestPhotos();
  schedule();
}

function rangeLabel(side: string | null): string {
  return side ? abbreviateRange(ranges.get(side) ?? '') : '';
}

function showOpening(): void {
  const here = openingOf(opening);
  const sides = [here.right, here.left].filter(Boolean) as string[];
  const title = sides.length ? `Folio${sides.length > 1 ? 's' : ''} ${sides.join(' · ')}` : 'Blank opening';
  const range = sides.map(rangeLabel).join(' · ') || 'No encoded text on this opening';
  $('.folio-title h1').textContent = title;
  $('.folio-title .folio-range').textContent = range;
  $('.jump-body p').textContent = `Opening ${opening - first + 1} of ${last - first + 1}`;
  document.title = `${title} · Codex · Leningrad Codex TEI`;
  const anchor = sides[0];
  if (anchor) history.replaceState(null, '', `#${anchor}${pinned ? `/${refToHash(pinned)}` : ''}`);
  live.textContent = `${title}. ${range}.`;
  scrub.value = String(opening);
  scrub.setAttribute('aria-valuetext', `${title}, ${range}`);
  scrubLabel.textContent = bookAt(spans, opening)?.label ?? '';
  const current = bookAt(spans, opening)?.book;
  for (const button of booksStrip.querySelectorAll<HTMLElement>('button')) {
    button.toggleAttribute('data-current', button.dataset.book === current);
  }
  $<HTMLButtonElement>('#codex-prev').disabled = opening <= first && (!isNarrow() || focusSide === 'right');
  $<HTMLButtonElement>('#codex-next').disabled = opening >= last && (!isNarrow() || focusSide === 'left');
}

/* ---------- Verses and copying ---------- */

function applyVerseClasses(): void {
  for (const run of surface.querySelectorAll<HTMLElement>('.verse-run')) {
    const ref = run.dataset.verse;
    run.classList.toggle('on', Boolean(hovered) && ref === hovered);
    run.classList.toggle('pin', Boolean(pinned) && ref === pinned);
  }
}

function setPin(ref: string | null): void {
  if (pinned === ref) return;
  pinned = ref;
  applyVerseClasses();
  updateCard();
  if (known.size) showOpening();
}

/** The folio sides around the opening, in reading order, with their text loaded. */
async function nearbyDocs() {
  const sides = [...new Set(neighborSides(opening))].filter(Boolean) as string[];
  sides.sort();
  const entries = await Promise.all(sides.map((s) => store.ensure(s)));
  return entries.flatMap((e) => (e ? [e.doc] : []));
}

function locateVerse(ref: string): { side: string; summary: string } | null {
  const here = openingOf(opening);
  for (const side of [here.right, here.left]) {
    const entry = store.get(side);
    const verse = entry?.view.verses.find((v) => v.ref === ref);
    if (entry && verse) return { side: entry.side, summary: lineSummary(verse.lines) };
  }
  return null;
}

function updateCard(): void {
  if (selectionText) {
    const words = selectionText.trim().split(/\s+/).length;
    cardText.textContent = `${words} word${words === 1 ? '' : 's'} selected`;
    cardText.dir = 'ltr';
    cardCopy.textContent = 'Copy selection';
    cardLink.hidden = true;
    card.hidden = false;
    return;
  }
  if (pinned) {
    const found = locateVerse(pinned);
    cardText.textContent = found ? `${pinned} · ${found.side} · ${found.summary}` : pinned;
    cardCopy.textContent = 'Copy verse';
    cardLink.hidden = !found;
    if (found) cardLink.href = `/folio/${found.side}/#${refToHash(pinned)}`;
    card.hidden = false;
    return;
  }
  card.hidden = true;
}

cardCopy.addEventListener('click', async () => {
  const label = cardCopy.textContent;
  try {
    const text = selectionText || (pinned ? `${verseText(await nearbyDocs(), pinned)}\n${pinned}` : '');
    await navigator.clipboard.writeText(text);
    cardCopy.textContent = 'Copied';
  } catch {
    cardCopy.textContent = 'Copy failed';
  }
  setTimeout(() => {
    cardCopy.textContent = label;
  }, 1600);
});

document.addEventListener('selectionchange', () => {
  const selection = getSelection();
  const within = selection && !selection.isCollapsed && selection.anchorNode && surface.contains(selection.anchorNode);
  const text = within ? selection.toString() : '';
  if (text === selectionText) return;
  selectionText = text;
  updateCard();
});

surface.addEventListener('click', (event) => {
  if (selectionText) return;
  const run = (event.target as HTMLElement).closest<HTMLElement>('.verse-run');
  if (run?.dataset.verse) setPin(pinned === run.dataset.verse ? null : run.dataset.verse);
});

surface.addEventListener('pointerover', (event) => {
  const run = (event.target as HTMLElement).closest<HTMLElement>('.verse-run');
  const next = run?.dataset.verse ?? null;
  if (next !== hovered) {
    hovered = next;
    applyVerseClasses();
  }
});

/* ---------- Pointer ---------- */

const pointers = new Map<number, { x: number; y: number }>();
let pinchDistance = 0;
let cameraDrag: { x: number; y: number; moved: number; onPage: boolean } | null = null;
let turnDrag: { startX: number; startY: number; lastT: number; lastTime: number; speed: number; moved: number } | null = null;
let blockNativeDrag = false;

/** The hand shows where a drag moves the view. The styles in `codex.astro` read this. */
function showPanCursor(): void {
  const next = cameraDrag ? 'held' : zoom > 1.05 ? 'ready' : '';
  if ((surface.dataset.pan ?? '') === next) return;
  if (next) surface.dataset.pan = next;
  else delete surface.dataset.pan;
}

function setCursor(value: string): void {
  if (surface.style.cursor !== value) surface.style.cursor = value;
}

/** The outer part of a resting page is its handle. The text stops short of it on every folio side. */
const HANDLE_U = 0.915;

function handleAt(x: number, y: number): { dir: 1 | -1; v: number } | null {
  const hit = view.locate(x, y);
  if (!hit || hit.u < HANDLE_U) return null;
  const dir: 1 | -1 = hit.side === 'left' ? 1 : -1;
  const to = opening + dir;
  if (to < first || to > last) return null;
  return { dir, v: hit.v };
}

function trackLens(event: PointerEvent): void {
  if (mode !== 'lens') return;
  const hit = view.locate(event.clientX, event.clientY);
  lens = hit ? { x: (hit.side === 'left' ? -1 : 1) * hit.u * PAGE_W, y: 0.5 - hit.v } : null;
  schedule();
}

surface.addEventListener('pointerdown', (event) => {
  dismissHint();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
    if (held) releaseHeld(false);
    turnDrag = null;
    cameraDrag = null;
    blockNativeDrag = true;
    return;
  }
  if (event.button !== 0) return;
  blockNativeDrag = false;
  const handle = event.shiftKey ? null : handleAt(event.clientX, event.clientY);
  if (handle) {
    const leaf = holdLeaf(handle.dir, handle.v);
    if (!leaf) return;
    leaf.held = true;
    surface.setPointerCapture(event.pointerId);
    leaf.target = leaf.t;
    leaf.flight = null;
    turnDrag = { startX: event.clientX, startY: event.clientY, lastT: leaf.t, lastTime: event.timeStamp, speed: 0, moved: 0 };
    blockNativeDrag = true;
    setCursor('grabbing');
    return;
  }
  // Zoomed in, the pages fill the stage, so a drag that starts off the text moves the view.
  // A drag on the text still selects it. On a touch screen one finger moves the view anywhere.
  const onPage = Boolean(view.locate(event.clientX, event.clientY));
  const onText = Boolean((event.target as Element).closest?.('.codex-he'));
  const panFromPage = zoom > 1.05 && (!onText || event.pointerType === 'touch');
  if (event.shiftKey || panFromPage || !onPage) {
    surface.setPointerCapture(event.pointerId);
    cameraDrag = { x: event.clientX, y: event.clientY, moved: 0, onPage };
    blockNativeDrag = true;
    setCursor('grabbing');
  }
});

/* Native text selection starts on mouse down, so a drag that is ours has to stop it there. */
surface.addEventListener('mousedown', (event) => {
  if (blockNativeDrag) event.preventDefault();
});

surface.addEventListener('pointermove', (event) => {
  if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  trackLens(event);
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const distance = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinchDistance) setZoom(zoom * (distance / pinchDistance), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    pinchDistance = distance;
    return;
  }
  if (turnDrag && held) {
    const world = view.worldAt(event.clientX, event.clientY);
    if (world) {
      const t = leafAngleForX(world.x);
      const seconds = Math.max(0.001, (event.timeStamp - turnDrag.lastTime) / 1000);
      turnDrag.speed = (t - turnDrag.lastT) / seconds;
      turnDrag.lastT = t;
      turnDrag.lastTime = event.timeStamp;
      turnDrag.moved = Math.max(turnDrag.moved, Math.hypot(event.clientX - turnDrag.startX, event.clientY - turnDrag.startY));
      held.target = t;
      held.gripTarget = (0.5 - clamp(0.5 - world.y, 0, 1)) * 2 * held.dir;
      schedule();
    }
    return;
  }
  if (cameraDrag) {
    const dx = event.clientX - cameraDrag.x;
    const dy = event.clientY - cameraDrag.y;
    cameraDrag = { ...cameraDrag, x: event.clientX, y: event.clientY, moved: cameraDrag.moved + Math.hypot(dx, dy) };
    const scale = (pose.dist * 0.42) / stage.clientHeight;
    if (zoom > 1.05 || !view.canOrbit || event.shiftKey) {
      panX -= dx * scale;
      panY += dy * scale;
      clampPan();
    } else {
      orbitYaw = clamp(orbitYaw - dx * 0.0035, -0.9, 0.9);
      orbitPitch = clamp(orbitPitch + dy * 0.0035, 0, 1.05);
    }
    schedule();
    return;
  }
  if (event.pointerType === 'mouse' && event.buttons === 0 && !reducedMotion) {
    const handle = handleAt(event.clientX, event.clientY);
    if (handle) {
      setCursor('grab');
      // A leaf still in the air finishes its flight before the next one lifts.
      if (leaves.every((l) => l.pending)) peel(handle.dir, handle.v);
    } else {
      setCursor('');
      dropPeel();
    }
  }
});

function endPointer(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  if (turnDrag) {
    const leaf = held;
    const drag = turnDrag;
    turnDrag = null;
    setCursor('');
    if (leaf) {
      const clicked = drag.moved < 5;
      // A hand that stopped before it let go has no speed left.
      const speed = event.timeStamp - drag.lastTime > 120 ? 0 : drag.speed;
      const going = leaf.dir > 0 ? leaf.target > 0.32 || speed > 1.1 : leaf.target < 0.68 || speed < -1.1;
      releaseHeld(event.type !== 'pointercancel' && (clicked || going));
    }
  }
  if (cameraDrag) {
    // A click beside the text clears a selection, as it would with no drag to start.
    if (cameraDrag.onPage && cameraDrag.moved < 4) getSelection()?.removeAllRanges();
    cameraDrag = null;
    setCursor('');
    schedule();
  }
  if (pointers.size < 2) pinchDistance = 0;
}
surface.addEventListener('pointerup', endPointer);
surface.addEventListener('pointercancel', endPointer);
surface.addEventListener('pointerleave', () => {
  if (turnDrag || cameraDrag) return;
  lens = null;
  setCursor('');
  dropPeel();
  schedule();
});

surface.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault();
    dismissHint();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.012 : 0.0016));
    setZoom(zoom * factor, { x: event.clientX, y: event.clientY });
  },
  { passive: false },
);

/* A double click in a page's margin flies in to that page. A second one flies back. */
surface.addEventListener('dblclick', (event) => {
  if ((event.target as HTMLElement).closest('.verse-run')) return;
  const hit = view.locate(event.clientX, event.clientY);
  if (!hit) return;
  if (zoom > 1.2) return resetCamera();
  zoom = 2;
  panX = hit.side === 'left' ? -PAGE_W / 2 : PAGE_W / 2;
  panY = 0;
  schedule();
});

/* ---------- Controls ---------- */

function setMode(next: ViewMode): void {
  mode = next;
  surface.dataset.mode = next;
  for (const button of document.querySelectorAll<HTMLElement>('[data-mode-choice]')) {
    button.setAttribute('aria-pressed', String(button.dataset.modeChoice === next));
  }
  if (next !== 'lens') lens = null;
  if (next === 'photo') {
    // The photograph has no selectable text, so nothing may stay marked on it.
    getSelection()?.removeAllRanges();
    hovered = null;
    setPin(null);
    applyVerseClasses();
  }
  if (next !== 'text') requestPhotos();
  showPhotoNote();
  schedule();
}

function requestPhotos(): void {
  const here = openingOf(opening);
  for (const side of [here.right, here.left]) store.photo(side, photosChanged, true);
  // The neighbors get their previews now, so a turned page has its photograph at once.
  for (const side of neighborSides(opening)) store.photo(side, photosChanged, false);
  showPhotoNote();
}

function photosChanged(): void {
  showPhotoNote();
  schedule();
}

function showPhotoNote(): void {
  if (mode === 'text') return setNote(plainNote);
  const here = openingOf(opening);
  const states = [here.right, here.left].flatMap((s) => (s ? [store.get(s)?.photo ?? 'loading'] : []));
  if (states.includes('loading')) setNote('Fetching the photographs from the Internet Archive.');
  else if (states.includes('missing')) setNote('No photograph could be loaded for a page on this opening.');
  else setNote(plainNote);
}

function setNote(text: string): void {
  note.textContent = text;
  note.hidden = !text;
}

const plainNote = plain ? 'This browser shows a plain book. Chrome 157 or later draws the full 3D book with HTML-in-Canvas.' : '';

for (const button of document.querySelectorAll<HTMLElement>('[data-mode-choice]')) {
  button.addEventListener('click', () => setMode(button.dataset.modeChoice as ViewMode));
}
$('#codex-next').addEventListener('click', () => step(1));
$('#codex-prev').addEventListener('click', () => step(-1));
$('#codex-zoom-in').addEventListener('click', () => setZoom(zoom * 1.35));
$('#codex-zoom-out').addEventListener('click', () => setZoom(zoom / 1.35));
$('#codex-reset').addEventListener('click', resetCamera);

scrub.addEventListener('input', () => {
  const n = Number(scrub.value);
  const span = bookAt(spans, n);
  const o = openingOf(n);
  scrubLabel.textContent = [span?.label, o.right ?? o.left].filter(Boolean).join(' · ');
});
scrub.addEventListener('change', () => void jumpTo(Number(scrub.value)));

function dismissHint(): void {
  if (hint.hidden) return;
  hint.hidden = true;
  try {
    localStorage.setItem('codex-hint-seen', '1');
  } catch {
    /* A private window can refuse storage. The hint then shows next time too. */
  }
}
$('#codex-hint-close').addEventListener('click', dismissHint);

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if ((event.target as Element).closest?.('input, select, textarea, [popover]')) return;
  const jump = $<HTMLElement>('#folio-jump-body');
  const handled = () => {
    event.preventDefault();
    dismissHint();
  };
  // The codex reads right to left, so the next page is to the left.
  if (event.key === 'ArrowLeft') (handled(), repeatStep(event, 1));
  else if (event.key === 'ArrowRight') (handled(), repeatStep(event, -1));
  else if (event.key === 'Home') (handled(), void jumpTo(first));
  else if (event.key === 'End') (handled(), void jumpTo(last));
  else if (event.key === '+' || event.key === '=') (handled(), setZoom(zoom * 1.35));
  else if (event.key === '-') (handled(), setZoom(zoom / 1.35));
  else if (event.key === '0') (handled(), resetCamera());
  else if (event.key === 't') (handled(), setMode('text'));
  else if (event.key === 'l') (handled(), setMode('lens'));
  else if (event.key === 'p') (handled(), setMode('photo'));
  else if (event.key === '/') {
    handled();
    if (!jump.matches(':popover-open')) jump.showPopover();
  } else if (event.key === 'Escape') {
    setPin(null);
    getSelection()?.removeAllRanges();
  }
});

/* ---------- Go to ---------- */

const jump = $<HTMLElement>('#folio-jump-body');
const gotoInput = $<HTMLInputElement>('#goto-input');
const gotoList = $('#goto-list');
let firstRoute: string | null = null;

function renderGoTo(): void {
  const query = gotoInput.value;
  gotoList.hidden = !query.trim();
  firstRoute = null;
  if (!query.trim()) return;
  const hits = searchFolios(list, query);
  firstRoute = hits[0] ? folioHrefToRoute(hits[0].href) : null;
  gotoList.replaceChildren(
    ...(hits.length
      ? hits.map((hit, i) => {
          const item = document.createElement('li');
          const link = document.createElement('a');
          link.href = folioHrefToRoute(hit.href);
          if (i === 0) link.className = 'first';
          const name = document.createElement('span');
          name.textContent = `Folio ${hit.folio}`;
          const range = document.createElement('small');
          range.textContent = hit.range.replace(/_/g, ' ');
          link.append(name, range);
          item.append(link);
          return item;
        })
      : [Object.assign(document.createElement('li'), { className: 'goto-none', textContent: 'No match. Try Exod 3:14 or 250A.' })]),
  );
}
jump.addEventListener('toggle', (event) => {
  if ((event as ToggleEvent).newState === 'open') gotoInput.focus();
});
gotoInput.addEventListener('input', renderGoTo);
gotoInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (firstRoute) location.hash = firstRoute;
  }
});
gotoList.addEventListener('click', () => {
  jump.hidePopover();
});

/* ---------- Theme ---------- */

function themeChanged(): void {
  view.refreshTheme();
  schedule();
}
new MutationObserver(themeChanged).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeChanged);

/* ---------- Route ---------- */

async function followRoute(): Promise<void> {
  const route = parseRoute(location.hash);
  if (!route.side || !known.has(route.side)) return;
  const n = openingOfSide(route.side);
  if (n === null) return;
  if (isNarrow()) focusSide = route.side.endsWith('A') ? 'left' : 'right';
  if (n !== opening) await jumpTo(n);
  jump.hidePopover();
  if (route.verse) {
    const key = hashToKey(route.verse);
    const entry = await store.ensure(route.side);
    const match = entry?.view.verses.find((v) => refKey(v.ref) === key);
    if (match) setPin(match.ref);
  }
}
addEventListener('hashchange', () => void followRoute());

/* ---------- Start ---------- */

function fitBookNames(): void {
  for (const button of booksStrip.children) button.classList.toggle('codex-book-narrow', button.scrollWidth > button.clientWidth);
}

function measureHud(): void {
  insetBottom = hud.offsetHeight + 12;
  schedule();
}

async function start(): Promise<void> {
  list = (await (await fetch('/folios.json')).json()) as [string, string][];
  known = new Set(list.map(([side]) => side));
  ranges = new Map(list);
  spans = bookSpans(list);
  ({ first, last } = openingRange(list.map(([side]) => side)));
  scrub.min = String(first);
  scrub.max = String(last);

  booksStrip.replaceChildren(
    ...spans.map((span) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.book = span.book;
      button.dataset.section = span.section;
      button.title = span.book.replace(/_/g, ' ');
      button.setAttribute('aria-label', `Go to ${button.title}`);
      button.style.flexGrow = String(Math.max(1, span.end - span.start));
      button.textContent = span.label;
      button.addEventListener('click', () => void jumpTo(span.start));
      return button;
    }),
  );

  new ResizeObserver(fitBookNames).observe(booksStrip);

  const route = parseRoute(location.hash);
  const startSide = route.side && known.has(route.side) ? route.side : list[0][0];
  opening = clamp(openingOfSide(startSide) ?? first, first, last);
  landed = opening;
  if (isNarrow()) focusSide = startSide.endsWith('A') ? 'left' : 'right';

  measureHud();
  new ResizeObserver(measureHud).observe(hud);
  new ResizeObserver(schedule).observe(stage);

  store.retain(neighborSides(opening));
  const goal = targetPose();
  pose = reducedMotion ? goal : { ...goal, pitch: 0.95, yaw: -0.5, dist: goal.dist * 1.5, y: goal.y - 0.1 };
  try {
    hint.hidden = localStorage.getItem('codex-hint-seen') === '1';
  } catch {
    hint.hidden = false;
  }
  setMode('text');
  showOpening();
  // The plain book says why once, then gives the room back to the page.
  if (plain) setTimeout(() => plainNote === note.textContent && setNote(''), 9000);
  await followRoute();
  schedule();
}

void start();

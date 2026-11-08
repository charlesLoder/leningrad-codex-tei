/**
 * The geometry of the book: camera, page turn, and the matrix that keeps a page's
 * DOM element under its drawn pixels. No DOM or WebGL here. The GLSL in `gl-view.ts`
 * repeats `leafArc`, so keep the two in step.
 *
 * World units: a page is `PAGE_H` tall. The spine is the line x = 0, y runs from
 * the tail of the page to its head, and z points up out of the desk.
 *
 * The book lies open as on a book scanner: a cradle holds the two open pages level
 * at `PAGE_Z`, however much paper lies on each side. Zoomed out, the book tilts away
 * from the reader. Zoomed in, the camera looks straight down.
 */

export const PAGE_H = 1;
/** The median proportion of a leaf in the photographs. */
export const PAGE_W = 0.88;
/** The most that the free edge of a turning leaf leads or trails its root, in radians. */
export const BEND = 0.62;
/**
 * The share of the curl that the root makes up by lagging behind. The root never
 * turns back while this is at most 0.5. The free edge makes up the rest, and slows a
 * little at the top, but never turns back while its share is below 0.5 too.
 */
export const ROOT_LAG = 0.5;
export const BOARD = 0.022;
/** The height of the whole text block on a page 1 unit tall. */
export const BLOCK = 0.15;
/** The height of the two open pages above the desk. The cradle makes up the rest under each stack. */
export const PAGE_Z = BOARD + 0.006 + BLOCK;
/** How far the fore-edge of a stack slants out, for each unit of its depth. */
export const FAN = 0.45;
/** A long lens from far away, as a scanner has, so a rising leaf does not swell toward the reader. */
export const FOV = (16 * Math.PI) / 180;
/** The tilt of the book when zoomed all the way out. It flattens as the reader comes closer. */
export const REST_PITCH = 0.3;

export type Mat4 = Float64Array<ArrayBuffer>;
export type Vec3 = [number, number, number];

export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

export function invert(m: Mat4): Mat4 {
  const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;
  const det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  const d = 1 / det;
  return Float64Array.of(
    (a11 * b11 - a12 * b10 + a13 * b09) * d,
    (a02 * b10 - a01 * b11 - a03 * b09) * d,
    (a31 * b05 - a32 * b04 + a33 * b03) * d,
    (a22 * b04 - a21 * b05 - a23 * b03) * d,
    (a12 * b08 - a10 * b11 - a13 * b07) * d,
    (a00 * b11 - a02 * b08 + a03 * b07) * d,
    (a32 * b02 - a30 * b05 - a33 * b01) * d,
    (a20 * b05 - a22 * b02 + a23 * b01) * d,
    (a10 * b10 - a11 * b08 + a13 * b06) * d,
    (a01 * b08 - a00 * b10 - a03 * b06) * d,
    (a30 * b04 - a31 * b02 + a33 * b00) * d,
    (a21 * b02 - a20 * b04 - a23 * b00) * d,
    (a11 * b07 - a10 * b09 - a12 * b06) * d,
    (a00 * b09 - a01 * b07 + a02 * b06) * d,
    (a31 * b01 - a30 * b03 - a32 * b00) * d,
    (a20 * b03 - a21 * b01 + a22 * b00) * d,
  );
}

/** A point through a matrix, with the homogeneous divide. */
export function project(m: Mat4, [x, y, z]: Vec3): Vec3 {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** What the camera looks at, how far away it is, and its angles. A pitch of 0 looks straight down. */
export interface Pose {
  x: number;
  y: number;
  z: number;
  dist: number;
  yaw: number;
  pitch: number;
}

export function eyeOf(p: Pose): Vec3 {
  return [
    p.x + p.dist * Math.sin(p.pitch) * Math.sin(p.yaw),
    p.y - p.dist * Math.sin(p.pitch) * Math.cos(p.yaw),
    p.z + p.dist * Math.cos(p.pitch),
  ];
}

/**
 * World to clip space. `shiftY` moves the picture up the screen in clip units, to
 * center the book in the room that the controls leave.
 */
export function viewProjection(p: Pose, aspect: number, shiftY = 0): Mat4 {
  const eye = eyeOf(p);
  const f = normalize(sub([p.x, p.y, p.z], eye));
  const r = normalize(cross(f, [-Math.sin(p.yaw), Math.cos(p.yaw), 0]));
  const u = cross(r, f);
  const view = Float64Array.of(r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot(r, eye), -dot(u, eye), dot(f, eye), 1);
  const near = p.dist * 0.05;
  const far = p.dist * 20;
  const t = 1 / Math.tan(FOV / 2);
  const proj = Float64Array.of(t / aspect, 0, 0, 0, 0, t, 0, 0, 0, -shiftY, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0);
  return multiply(proj, view);
}

export interface BookBox {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  z0: number;
  z1: number;
}

/**
 * The closest distance that shows the whole box above the controls, and the shift
 * that centers it there. `room` is the share of the screen height the controls leave.
 */
export function fitBox(pose: Pose, aspect: number, room: number, box: BookBox): { dist: number; shiftY: number } {
  const corners: Vec3[] = [];
  for (const x of [box.x0, box.x1]) for (const y of [box.y0, box.y1]) for (const z of [box.z0, box.z1]) corners.push([x, y, z]);
  const measure = (dist: number) => {
    const vp = viewProjection({ ...pose, dist }, aspect);
    const points = corners.map((c) => project(vp, c));
    const ys = points.map((p) => p[1]);
    return { halfX: Math.max(...points.map((p) => Math.abs(p[0]))), low: Math.min(...ys), high: Math.max(...ys) };
  };
  let near = 0.5;
  let far = 40;
  for (let i = 0; i < 24; i++) {
    const dist = (near + far) / 2;
    const { halfX, low, high } = measure(dist);
    if (halfX <= 0.985 && (high - low) / 2 <= room * 0.97) far = dist;
    else near = dist;
  }
  const { low, high } = measure(far);
  return { dist: far, shiftY: 1 - room - (low + high) / 2 };
}

/** Where the ray through a screen point (in clip units) meets the plane at height z. */
export function hitPlane(inverseVp: Mat4, ndcX: number, ndcY: number, z: number): { x: number; y: number } | null {
  const a = project(inverseVp, [ndcX, ndcY, -1]);
  const b = project(inverseVp, [ndcX, ndcY, 1]);
  const dz = b[2] - a[2];
  if (Math.abs(dz) < 1e-9) return null;
  const k = (z - a[2]) / dz;
  if (k < 0) return null;
  return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k };
}

/** The depth of paper under each open page. `progress` is 0 at the first opening and 1 at the last. */
export function stackDepths(progress: number): { left: number; right: number } {
  const p = Math.min(1, Math.max(0, progress));
  return { left: 0.006 + BLOCK * (1 - p), right: 0.006 + BLOCK * p };
}

/**
 * How far from the spine the bottom of a stack reaches. A straight edge would hide
 * under the open page in an overhead view, so the slant is what shows the paper.
 */
export const foreEdgeReach = (depth: number): number => PAGE_W + FAN * depth;

/**
 * A point of a turning leaf, relative to its root at the spine, as a share of the
 * page width. `t` is 0 with the leaf flat on the left and 1 flat on the right. The
 * free edge leads while the leaf lifts and trails while it falls, as paper does when
 * a hand carries it over. The root and the free edge both turn one way only, so the
 * leaf never stops at the top to change its bend.
 */
export function leafArc(u: number, t: number): { x: number; z: number; phi: number } {
  const wave = Math.sin(2 * Math.PI * t);
  const bend = -BEND * wave;
  const root = Math.PI * (1 - t) + ROOT_LAG * wave;
  const phi = root + bend * u;
  if (Math.abs(bend) < 1e-3) return { x: u * Math.cos(root), z: u * Math.sin(root), phi };
  return { x: (Math.sin(phi) - Math.sin(root)) / bend, z: (Math.cos(root) - Math.cos(phi)) / bend, phi };
}

/** The path of a leaf in flight, from its angle and speed to a stop. */
export interface Flight {
  from: number;
  speed: number;
  to: number;
  seconds: number;
  elapsed: number;
}

/**
 * Plans a flight. A short way takes less time than a whole turn. The speed of a fast
 * release is kept only as far as the path stays free of overshoot, which needs a
 * start no steeper than 2.5 times the average speed. A leaf sent back keeps its speed
 * too: it carries on for a moment, slows, and comes back, as paper does. `launch` is
 * the least speed to start with, as a share of the average speed, so that a turn the
 * reader asks for moves at once.
 */
export function planFlight(t: number, v: number, to: number, pace: number, launch = 0): Flight {
  const way = to - t;
  const seconds = pace * (0.45 + 0.55 * Math.sqrt(Math.abs(way)));
  const kept = way === 0 ? 0 : (v * seconds) / way;
  const steep = way === 0 ? 0 : Math.min(2, Math.max(-6, launch > 0 ? Math.max(launch, kept) : kept));
  return { from: t, speed: (steep * way) / seconds, to, seconds, elapsed: 0 };
}

/**
 * Where a flight is now. The curve is a quintic with no acceleration at either end,
 * so the leaf eases out of a rest, and stops with no kink at the end of the time.
 */
export function flightAt(f: Flight): { t: number; v: number } {
  const s = Math.min(1, f.elapsed / f.seconds);
  const s2 = s * s;
  const s3 = s2 * s;
  const s4 = s2 * s2;
  const s5 = s3 * s2;
  const blend = 10 * s3 - 15 * s4 + 6 * s5;
  const blendRate = 30 * s2 - 60 * s3 + 30 * s4;
  const carry = s - 6 * s3 + 8 * s4 - 3 * s5;
  const carryRate = 1 - 18 * s2 + 32 * s3 - 15 * s4;
  return {
    t: Math.min(1, Math.max(0, f.from + (f.to - f.from) * blend + f.speed * f.seconds * carry)),
    v: ((f.to - f.from) * blendRate) / f.seconds + f.speed * carryRate,
  };
}

/**
 * The shadow that the leaves in the air cast on the open pages. It grows from nothing
 * as a leaf lifts. Several leaves blend by how high each one is, so no leaf takes
 * over the shadow all at once.
 */
export function leafShadow(angles: number[]): { x: number; height: number; strength: number } {
  let weight = 0;
  let x = 0;
  let height = 0;
  let strength = 0;
  for (const t of angles) {
    const lift = Math.sin(Math.PI * t) ** 2;
    const tip = leafArc(1, t);
    weight += lift;
    x += tip.x * lift;
    height += tip.z * lift;
    strength = Math.max(strength, lift);
  }
  return weight > 0 ? { x: x / weight, height: height / weight, strength } : { x: 0, height: 0, strength: 0 };
}

/** The leaf angle that puts its free edge above a world x position. The inverse of the flat part of `leafArc`. */
export const leafAngleForX = (x: number): number => 1 - Math.acos(Math.min(1, Math.max(-1, x / PAGE_W))) / Math.PI;

/**
 * Maps a resting page's element, in its CSS pixels, to the canvas, in its CSS pixels.
 * The third row is flattened because only the picture on the screen matters.
 */
export function pageHomography(
  vp: Mat4,
  side: 'left' | 'right',
  height: number,
  element: { width: number; height: number },
  canvas: { width: number; height: number },
): Mat4 {
  const toWorld = Float64Array.of(PAGE_W / element.width, 0, 0, 0, 0, -PAGE_H / element.height, 0, 0, 0, 0, 1, 0, side === 'left' ? -PAGE_W : 0, PAGE_H / 2, height, 1);
  const toCanvas = Float64Array.of(canvas.width / 2, 0, 0, 0, 0, -canvas.height / 2, 0, 0, 0, 0, 1, 0, canvas.width / 2, canvas.height / 2, 0, 1);
  const out = multiply(toCanvas, multiply(vp, toWorld));
  out[2] = 0;
  out[6] = 0;
  out[10] = 1;
  out[14] = 0;
  return out;
}

export const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

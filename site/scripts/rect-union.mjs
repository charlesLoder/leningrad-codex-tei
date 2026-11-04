/**
 * Rectilinear union outline for a set of axis-aligned integer rects.
 *
 * Verse zones are one rect per text line; stacked lines form a stepped
 * shape, not a single rectangle. This computes the outline of the union
 * as one SVG path (possibly several subpaths for disjoint parts), so a
 * verse becomes a single polygon target instead of N boxes.
 *
 * Method: rasterize onto the grid formed by all rect edges, mark covered
 * cells, then trace cell-boundary edges. Correct for overlapping,
 * touching, and disjoint rects.
 */

/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */

/**
 * Outline loops of the union. Each loop is a list of [x, y] corners.
 * @param {Rect[]} rects integer rects
 * @returns {Array<Array<[number, number]>>}
 */
export function unionOutline(rects) {
  const boxes = rects
    .map((r) => ({
      x1: Math.round(r.x),
      y1: Math.round(r.y),
      x2: Math.round(r.x + r.w),
      y2: Math.round(r.y + r.h),
    }))
    .filter((b) => b.x2 > b.x1 && b.y2 > b.y1);
  if (boxes.length === 0) return [];

  const xs = [...new Set(boxes.flatMap((b) => [b.x1, b.x2]))].sort((a, b) => a - b);
  const ys = [...new Set(boxes.flatMap((b) => [b.y1, b.y2]))].sort((a, b) => a - b);
  const nx = xs.length - 1;
  const ny = ys.length - 1;

  const covered = Array.from({ length: nx }, () => new Array(ny).fill(false));
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      covered[i][j] = boxes.some(
        (b) => b.x1 <= xs[i] && b.x2 >= xs[i + 1] && b.y1 <= ys[j] && b.y2 >= ys[j + 1],
      );
    }
  }
  const isCovered = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && covered[i][j];

  // Directed boundary edges, clockwise in screen coords (y down).
  // Key: "x1,y1>x2,y2".
  /** @type {Map<string, Array<[number, number, number, number]>>} start -> ends */
  const outs = new Map();
  const addEdge = (x1, y1, x2, y2) => {
    const k = `${x1},${y1}`;
    if (!outs.has(k)) outs.set(k, []);
    outs.get(k).push([x2, y2]);
  };
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      if (!covered[i][j]) continue;
      if (!isCovered(i, j - 1)) addEdge(xs[i], ys[j], xs[i + 1], ys[j]); // top
      if (!isCovered(i + 1, j)) addEdge(xs[i + 1], ys[j], xs[i + 1], ys[j + 1]); // right
      if (!isCovered(i, j + 1)) addEdge(xs[i + 1], ys[j + 1], xs[i], ys[j + 1]); // bottom
      if (!isCovered(i - 1, j)) addEdge(xs[i], ys[j + 1], xs[i], ys[j]); // left
    }
  }

  // Trace loops. At pinch vertices (cells touching at a corner) prefer
  // going straight so touching parts stay separate loops.
  /** @type {Set<string>} */
  const used = new Set();
  const loops = [];
  const edgeKey = (x1, y1, x2, y2) => `${x1},${y1}>${x2},${y2}`;
  const unusedFrom = (x, y) =>
    (outs.get(`${x},${y}`) ?? []).filter(([x2, y2]) => !used.has(edgeKey(x, y, x2, y2)));
  const nextStart = () => {
    for (const [k] of outs) {
      const [x, y] = k.split(',').map(Number);
      if (unusedFrom(x, y).length > 0) return [x, y];
    }
    return null;
  };
  let s;
  while ((s = nextStart()) !== null) {
    const [sx, sy] = s;
    const loop = [[sx, sy]];
    let cx = sx;
    let cy = sy;
    let dx = 0;
    let dy = 0;
    let first = true;
    for (;;) {
      const cands = unusedFrom(cx, cy);
      if (cands.length === 0) break;
      let pick = cands.find(([x2, y2]) => !first && x2 - cx === dx && y2 - cy === dy);
      pick ??= cands[0];
      const [nx2, ny2] = pick;
      used.add(edgeKey(cx, cy, nx2, ny2));
      dx = nx2 - cx;
      dy = ny2 - cy;
      cx = nx2;
      cy = ny2;
      first = false;
      if (cx === sx && cy === sy) break;
      loop.push([cx, cy]);
      if (loop.length > outs.size + 2) break; // safety, should not happen
    }
    if (loop.length >= 3 && cx === sx && cy === sy) loops.push(loop);
  }
  return loops;
}

/**
 * Loops to an SVG path data string.
 * @param {Array<Array<[number, number]>>} loops
 */
export function loopsToPath(loops) {
  return loops
    .map((loop) => `M${loop.map(([x, y]) => `${x},${y}`).join('L')}Z`)
    .join('');
}

/**
 * Split line rects (reading order) at column jumps.
 *
 * A verse can end at the bottom of one column and resume at the top of
 * the next (e.g. Genesis 1:10). Merging those parts into one outline is
 * hard to read, so split when the text jumps back up the page: the next
 * rect's vertical center sits well above the previous one. Within a
 * column, consecutive lines always move down by ~one line height, so a
 * 10%-of-height drop only ever means a new column.
 *
 * @param {Rect[]} rects line rects in reading order (any consistent units)
 * @param {number} height page height in the same units
 * @returns {Rect[][]} one group per column part
 */
export function splitColumnSegments(rects, height) {
  const groups = [[]];
  for (const r of rects) {
    const cur = groups[groups.length - 1];
    if (cur.length > 0) {
      const prev = cur[cur.length - 1];
      const prevMid = prev.y + prev.h / 2;
      const curMid = r.y + r.h / 2;
      if (curMid < prevMid - height * 0.1) groups.push([]);
    }
    groups[groups.length - 1].push(r);
  }
  return groups.filter((g) => g.length > 0);
}

/**
 * Full `<svg>` value for an IIIF SvgSelector on a W x H canvas.
 * @param {Rect[]} rects
 * @param {number} width canvas width
 * @param {number} height canvas height
 * @returns {string | null} null when rects are empty
 */
export function verseSvg(rects, width, height) {
  const loops = unionOutline(rects);
  if (loops.length === 0) return null;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">` +
    `<path d="${loopsToPath(loops)}"/></svg>`
  );
}

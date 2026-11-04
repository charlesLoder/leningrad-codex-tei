import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { splitColumnSegments, unionOutline, loopsToPath, verseSvg } from '../scripts/rect-union.mjs';

describe('unionOutline', () => {
  it('outlines two stacked line rects as one stepped loop', () => {
    const loops = unionOutline([
      { x: 10, y: 0, w: 80, h: 10 },
      { x: 30, y: 10, w: 60, h: 10 },
    ]);
    assert.equal(loops.length, 1);
    // 8 corners: stepped left and right sides.
    assert.equal(loops[0].length, 8);
    const pts = new Set(loops[0].map(([x, y]) => `${x},${y}`));
    for (const p of ['10,0', '90,0', '90,20', '30,20', '30,10', '10,10']) {
      assert.ok(pts.has(p), `missing corner ${p}`);
    }
  });

  it('merges fully overlapping rects', () => {
    const loops = unionOutline([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 0, y: 0, w: 10, h: 10 },
    ]);
    assert.equal(loops.length, 1);
    assert.equal(loops[0].length, 4);
  });

  it('keeps disjoint rects as separate loops', () => {
    const loops = unionOutline([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 50, y: 50, w: 10, h: 10 },
    ]);
    assert.equal(loops.length, 2);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(unionOutline([]), []);
  });
});

describe('verseSvg', () => {
  it('wraps the path with the canvas viewBox', () => {
    const svg = verseSvg([{ x: 0, y: 0, w: 10, h: 10 }], 4239, 5231);
    assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4239 5231">'));
    assert.ok(svg.includes('<path d="M0,0L10,0L10,10L0,10Z"/></svg>'));
    assert.equal(verseSvg([], 1, 1), null);
  });

  it('emits one subpath per disjoint loop', () => {
    const svg = verseSvg(
      [
        { x: 0, y: 0, w: 10, h: 10 },
        { x: 50, y: 50, w: 10, h: 10 },
      ],
      100,
      100,
    );
    assert.equal((svg.match(/M/g) ?? []).length, 2);
  });
});

describe('loopsToPath', () => {
  it('joins loops into subpaths', () => {
    assert.equal(
      loopsToPath([[[0, 0], [10, 0], [10, 10]]]),
      'M0,0L10,0L10,10Z',
    );
  });
});

describe('splitColumnSegments', () => {
  // Genesis 1:10 shape: last line of one column, then top of the next.
  const colBreak = [
    { x: 660, y: 724, w: 147, h: 30 },
    { x: 434, y: 261, w: 170, h: 28 },
    { x: 434, y: 282, w: 171, h: 23 },
  ];
  it('splits when the text jumps back up the page', () => {
    const parts = splitColumnSegments(colBreak, 1000);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].length, 1);
    assert.equal(parts[1].length, 2);
  });

  it('keeps consecutive lines in one part', () => {
    const parts = splitColumnSegments(
      [
        { x: 10, y: 0, w: 80, h: 10 },
        { x: 30, y: 12, w: 60, h: 10 },
        { x: 10, y: 24, w: 80, h: 10 },
      ],
      1000,
    );
    assert.equal(parts.length, 1);
    assert.equal(parts[0].length, 3);
  });

  it('returns [] for empty input', () => {
    assert.deepEqual(splitColumnSegments([], 1000), []);
  });
});

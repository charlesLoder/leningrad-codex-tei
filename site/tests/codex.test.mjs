import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bookAt,
  bookSpans,
  openingAt,
  openingOfSide,
  openingRange,
  riffleSteps,
} from '../src/lib/codex/book.ts';
import { folioHrefToRoute, parseRoute, routeToFolioHref } from '../src/lib/codex/route.ts';
import { cropUrl, justifySpacing, layoutFolio, pageCrop, verseText } from '../src/lib/codex/layout.ts';
import {
  fitBox,
  flightAt,
  foreEdgeReach,
  hitPlane,
  invert,
  leafAngleForX,
  leafArc,
  leafShadow,
  multiply,
  PAGE_H,
  PAGE_W,
  PAGE_Z,
  pageHomography,
  planFlight,
  project,
  REST_PITCH,
  stackDepths,
  viewProjection,
} from '../src/lib/codex/math.ts';
import { parseColor } from '../src/lib/codex/theme.ts';
import { parseFolioXml } from '../src/lib/tei.ts';

const here = dirname(fileURLToPath(import.meta.url));
const read = (folio) => parseFolioXml(readFileSync(join(here, '..', '..', 'edition', `${folio}.xml`), 'utf8'));
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not near ${b}`);
const LIST = [
  ['001B', 'Genesis 1:1 – Genesis 1:26'],
  ['002A', 'Genesis 1:26 – Genesis 2:19'],
  ['051B', 'Exodus 1:1 – Exodus 1:20'],
  ['409B', 'Job 42:7 – Job 42:17; Proverbs 1:1 – Proverbs 1:19'],
  ['463A', 'Nehemiah 13:20 – Nehemiah 13:31'],
];

describe('the bound book', () => {
  it('faces a verso on the right with the next recto on the left', () => {
    const known = new Set(['001B', '002A', '021B', '022A']);
    assert.deepEqual(openingAt(1, known), { n: 1, right: '001B', left: '002A' });
    assert.deepEqual(openingAt(21, known), { n: 21, right: '021B', left: '022A' });
  });

  it('finds the opening of either side of a leaf', () => {
    assert.equal(openingOfSide('021A'), 20);
    assert.equal(openingOfSide('021B'), 21);
    assert.equal(openingOfSide('nope'), null);
    assert.deepEqual(openingRange(['001B', '463A']), { first: 1, last: 462 });
  });

  it('leaves a side that the edition does not have as null', () => {
    assert.deepEqual(openingAt(120, new Set(['120A'])), { n: 120, right: null, left: null });
  });

  it('lists books in codex order, also when two share a folio side', () => {
    const spans = bookSpans(LIST);
    assert.deepEqual(
      spans.map((b) => [b.label, b.start, b.end, b.section]),
      [
        ['Gen', 1, 51, 'torah'],
        ['Exod', 51, 409, 'torah'],
        ['Job', 409, 409, 'prophets'],
        ['Prov', 409, 462, 'prophets'],
        ['Neh', 462, 463, 'prophets'],
      ],
    );
    assert.equal(bookAt(spans, 60)?.label, 'Exod');
  });

  it('sorts the Writings from Chronicles on', () => {
    const spans = bookSpans([
      ['001B', 'Genesis 1:1 – Genesis 1:26'],
      ['200B', 'Malachi 1:1 – Malachi 1:2'],
      ['300B', 'Chronicles_1 1:1 – Chronicles_1 1:2'],
      ['400B', 'Psalms 1:1 – Psalms 1:2'],
    ]);
    assert.deepEqual(
      spans.map((b) => b.section),
      ['torah', 'prophets', 'writings', 'writings'],
    );
  });

  it('reads and writes routes', () => {
    assert.deepEqual(parseRoute('#021A'), { side: '021A', verse: null });
    assert.deepEqual(parseRoute('#021A/Gen-34-12'), { side: '021A', verse: 'Gen-34-12' });
    assert.deepEqual(parseRoute(''), { side: null, verse: null });
    assert.deepEqual(parseRoute('#Gen-34-12'), { side: null, verse: null });
    assert.equal(folioHrefToRoute('/folio/021A/#Gen-34-12'), '#021A/Gen-34-12');
    assert.equal(folioHrefToRoute('/folio/021A/'), '#021A');
  });

  it('sends a small screen to the matching folio page', () => {
    assert.equal(routeToFolioHref(parseRoute('#021B'), '001B'), '/folio/021B/');
    assert.equal(routeToFolioHref(parseRoute('#021B/Gen-35-5'), '001B'), '/folio/021B/#Gen-35-5');
    assert.equal(routeToFolioHref(parseRoute(''), '001B'), '/folio/001B/');
    assert.equal(routeToFolioHref(parseRoute('#nonsense'), '001B'), '/folio/001B/');
  });

  it('riffles in even steps and always lands on the target', () => {
    assert.deepEqual(riffleSteps(10, 13), [11, 12, 13]);
    assert.deepEqual(riffleSteps(13, 10), [12, 11, 10]);
    assert.deepEqual(riffleSteps(5, 5), []);
    const long = riffleSteps(1, 462);
    assert.equal(long.length, 14);
    assert.equal(long.at(-1), 462);
    assert.ok(long.every((s, i) => i === 0 || s > long[i - 1]));
  });
});

describe('the page turn', () => {
  it('lies flat at both ends', () => {
    for (const u of [0, 0.5, 1]) {
      near(leafArc(u, 0).x, -u);
      near(leafArc(u, 0).z, 0);
      near(leafArc(u, 1).x, u);
      near(leafArc(u, 1).z, 0, 1e-5);
    }
  });

  it('keeps the page length while it bends', () => {
    for (const t of [0.1, 0.3, 0.47, 0.7, 0.93]) {
      let length = 0;
      let last = leafArc(0, t);
      for (let i = 1; i <= 200; i++) {
        const p = leafArc(i / 200, t);
        length += Math.hypot(p.x - last.x, p.z - last.z);
        last = p;
      }
      near(length, 1, 1e-3);
    }
  });

  it('never passes below its root', () => {
    for (let t = 0; t <= 1; t += 0.02) {
      for (let u = 0; u <= 1; u += 0.05) assert.ok(leafArc(u, t).z > -1e-9, `t=${t} u=${u}`);
    }
  });

  it('moves its free edge one way only, in one continuous movement', () => {
    let last = leafArc(1, 0);
    for (let t = 0.005; t <= 1; t += 0.005) {
      const now = leafArc(1, t);
      assert.ok(now.phi < last.phi, `the free edge turns back at t=${t}`);
      assert.ok(now.x > last.x - 1e-9, `the free edge moves back at t=${t}`);
      last = now;
    }
  });

  it('never turns its root back', () => {
    let last = leafArc(0, 0).phi;
    for (let t = 0.005; t <= 1; t += 0.005) {
      const now = leafArc(0, t).phi;
      assert.ok(now <= last + 1e-9, `the root turns back at t=${t}`);
      last = now;
    }
  });

  it('follows the pointer across the spine', () => {
    near(leafAngleForX(-PAGE_W), 0);
    near(leafAngleForX(0), 0.5);
    near(leafAngleForX(PAGE_W), 1);
    near(leafAngleForX(PAGE_W * 3), 1);
  });

  it('moves paper from the left stack to the right as the reader goes on', () => {
    const start = stackDepths(0);
    const end = stackDepths(1);
    assert.ok(start.left > start.right);
    assert.ok(end.right > end.left);
    near(start.left, end.right);
    assert.ok(start.left <= PAGE_Z, 'the cradle has room for the deepest stack');
  });
});

describe('the shadow of a leaf', () => {
  it('is gone when the leaf lies flat', () => {
    assert.equal(leafShadow([]).strength, 0);
    near(leafShadow([0]).strength, 0);
    near(leafShadow([1]).strength, 0);
  });

  it('changes a little at a time through a whole turn', () => {
    let last = leafShadow([0]);
    for (let t = 0.01; t <= 1; t += 0.01) {
      const now = leafShadow([t]);
      assert.ok(Math.abs(now.strength - last.strength) < 0.04, `strength at ${t}`);
      if (last.strength > 0) assert.ok(Math.abs(now.x - last.x) < 0.07, `reach at ${t}`);
      last = now;
    }
  });

  it('blends two leaves with no jump when one passes the other', () => {
    let last = leafShadow([0.45, 0.55]);
    for (let d = 0; d <= 0.3; d += 0.005) {
      const now = leafShadow([0.45 + d, 0.55 - d]);
      assert.ok(Math.abs(now.x - last.x) < 0.05);
      last = now;
    }
  });
});

describe('the flight of a leaf', () => {
  const at = (f, elapsed) => flightAt({ ...f, elapsed });

  it('starts and lands at rest, exactly on its target', () => {
    const f = planFlight(0, 0, 1, 0.85);
    near(at(f, 0).t, 0);
    near(at(f, 0).v, 0);
    near(at(f, f.seconds).t, 1);
    near(at(f, f.seconds).v, 0);
  });

  it('eases out of a rest and into a stop, with no sudden step', () => {
    const f = planFlight(0, 0, 1, 0.85);
    const frame = 1 / 60;
    const steps = [];
    for (let time = 0; time < f.seconds; time += frame) steps.push(at(f, time + frame).t - at(f, time).t);
    for (let i = 1; i < steps.length; i++) assert.ok(steps[i] >= 0, 'it never goes back');
    for (let i = 1; i < steps.length; i++) assert.ok(Math.abs(steps[i] - steps[i - 1]) < 0.0035, `step ${i} changes too fast`);
    assert.ok(steps[0] < 0.001);
    assert.ok(steps.at(-1) < 0.001);
  });

  it('keeps the speed of a release, and does not overshoot', () => {
    const f = planFlight(0.6, 3, 1, 0.85);
    near(at(f, 0).t, 0.6);
    assert.ok(f.speed > 0);
    const small = 0.001;
    near(at(f, small).t, 0.6 + f.speed * small, 1e-4);
    for (let s = 0; s <= 1; s += 0.01) assert.ok(at(f, s * f.seconds).t <= 1 + 1e-9);
  });

  it('carries on for a moment when it is sent back, with no sudden stop', () => {
    const f = planFlight(0.3, 1.5, 0, 0.85);
    near(at(f, 0).v, 1.5);
    assert.ok(at(f, 0.03).t > 0.3);
    near(at(f, f.seconds).t, 0);
    for (let s = 0; s <= 1; s += 0.01) {
      const { t } = at(f, s * f.seconds);
      assert.ok(t >= 0 && t <= 0.6, `s=${s} t=${t}`);
    }
  });

  it('moves at once when the reader asks for a turn, and still lands at rest', () => {
    const plain = planFlight(0, 0, 1, 1.05);
    const quick = planFlight(0, 0, 1, 1.05, 0.7);
    const frame = 1 / 60;
    assert.ok(at(quick, frame).t > at(plain, frame).t * 20);
    assert.ok(at(quick, frame).t > 0.005);
    near(at(quick, quick.seconds).t, 1);
    near(at(quick, quick.seconds).v, 0);
    let last = 0;
    for (let s = 0.01; s <= 1; s += 0.01) {
      const { t } = at(quick, s * quick.seconds);
      assert.ok(t >= last && t <= 1 + 1e-9, `s=${s}`);
      last = t;
    }
  });

  it('takes less time over a short way', () => {
    assert.ok(planFlight(0, 0, 0.06, 0.85).seconds < planFlight(0, 0, 1, 0.85).seconds * 0.7);
    near(planFlight(0, 0, 1, 0.85).seconds, 0.85);
  });
});

describe('the book on its cradle', () => {
  const dist = 3;
  const overhead = { x: 0, y: 0, z: PAGE_Z, dist, yaw: 0, pitch: 0 };

  it('tilts away from the reader when zoomed all the way out', () => {
    assert.ok(REST_PITCH > 0);
  });

  it('shows both open pages square, at one scale, from straight above', () => {
    const vp = viewProjection(overhead, 1.5);
    const size = { width: 860, height: 977 };
    const canvas = { width: 1200, height: 800 };
    const [left, right] = ['left', 'right'].map((side) => pageHomography(vp, side, PAGE_Z, size, canvas));
    for (const m of [left, right]) {
      near(m[1], 0);
      near(m[3], 0);
      near(m[4], 0);
      near(m[7], 0);
    }
    near(left[0], right[0]);
    near(left[5], right[5]);
    near(left[13], right[13]);
    near(left[12] + left[0] * size.width, right[12]);
  });

  it('keeps the paper in view from straight above, more for the deeper stack', () => {
    const vp = viewProjection(overhead, 1.5);
    const page = project(vp, [PAGE_W, 0, PAGE_Z])[0];
    const shown = (depth) => project(vp, [foreEdgeReach(depth), 0, PAGE_Z - depth])[0] - page;
    const { left: deep, right: thin } = stackDepths(0);
    assert.ok(shown(thin) > 0);
    assert.ok(shown(deep) > shown(thin) * 2);
  });
});

describe('the camera', () => {
  const pose = { x: 0, y: 0, z: 0.1, dist: 3, yaw: 0.2, pitch: 0.4 };

  it('inverts a matrix', () => {
    const vp = viewProjection(pose, 1.5);
    const id = multiply(vp, invert(vp));
    id.forEach((v, i) => near(v, i % 5 === 0 ? 1 : 0, 1e-6));
  });

  it('finds the point it projected', () => {
    const vp = viewProjection(pose, 1.5, 0.1);
    const [x, y] = project(vp, [0.3, -0.2, 0.15]);
    const hit = hitPlane(invert(vp), x, y, 0.15);
    near(hit.x, 0.3, 1e-6);
    near(hit.y, -0.2, 1e-6);
  });

  it('moves the picture up the screen for a positive shift', () => {
    const plain = project(viewProjection(pose, 1.5), [0, 0, 0.1]);
    const shifted = project(viewProjection(pose, 1.5, 0.2), [0, 0, 0.1]);
    near(shifted[1] - plain[1], 0.2);
  });

  it('fits a tilted book above the controls', () => {
    const box = { x0: -0.91, x1: 0.91, y0: -0.53, y1: 0.53, z0: 0, z1: 0.17 };
    const tilted = { x: 0, y: 0, z: 0.08, dist: 1, yaw: 0, pitch: 0.3 };
    const { dist, shiftY } = fitBox(tilted, 1.7, 0.8, box);
    const vp = viewProjection({ ...tilted, dist }, 1.7, shiftY);
    const ys = [];
    for (const x of [box.x0, box.x1]) {
      for (const y of [box.y0, box.y1]) {
        for (const z of [box.z0, box.z1]) {
          const [px, py] = project(vp, [x, y, z]);
          assert.ok(Math.abs(px) <= 1);
          ys.push(py);
        }
      }
    }
    assert.ok(Math.max(...ys) <= 1 + 1e-6);
    // Above the controls, which take the bottom fifth: -0.6 in clip units.
    assert.ok(Math.min(...ys) >= -0.6 - 1e-6);
  });

  it('keeps a page element under its drawn pixels', () => {
    const vp = viewProjection(pose, 1200 / 800, 0.08);
    const element = { width: 860, height: 977 };
    const canvas = { width: 1200, height: 800 };
    for (const [side, x0] of [['left', -PAGE_W], ['right', 0]]) {
      const m = pageHomography(vp, side, 0.16, element, canvas);
      for (const [ex, ey] of [[0, 0], [860, 0], [0, 977], [860, 977], [333, 500]]) {
        const world = [x0 + (ex / 860) * PAGE_W, PAGE_H / 2 - (ey / 977) * PAGE_H, 0.16];
        const clip = project(vp, world);
        const [px, py] = project(m, [ex, ey, 0]);
        near(px, ((clip[0] + 1) / 2) * 1200, 1e-6);
        near(py, ((1 - clip[1]) / 2) * 800, 1e-6);
      }
    }
  });
});

describe('page layout', () => {
  it('crops the photograph to the proportions of a page, inside the image', () => {
    const doc = read('021A');
    const [x, y, w, h] = pageCrop(doc);
    near(w / h, PAGE_W / PAGE_H, 1e-3);
    assert.ok(x >= 0 && y >= 0 && x + w <= doc.facsimile.width + 1 && y + h <= doc.facsimile.height + 1);
  });

  it('ignores a stray zone when it crops the Song of the Sea', () => {
    const doc = read('040B');
    // Recognition puts the first segment of Exod 15:14 at the very top of the photograph.
    assert.ok(doc.facsimile.zones['Exod 15:14'].segments[0][1] < 100);
    const [, , w] = pageCrop(doc);
    assert.ok(w / doc.facsimile.width < 0.85, `the crop is ${w} of ${doc.facsimile.width}`);
  });

  it('keeps the text clear of the page-turn handle on every folio side', () => {
    const dir = join(here, '..', '..', 'edition');
    const sides = readdirSync(dir).filter((f) => /^\d{3}[AB]\.xml$/.test(f));
    for (const file of sides) {
      const layout = layoutFolio(parseFolioXml(readFileSync(join(dir, file), 'utf8')));
      const recto = file.includes('A');
      for (const col of layout.columns) {
        // On a recto the fore-edge is on the left of the element, and on a verso on the right.
        const u = recto ? 1 - col.left : col.right;
        assert.ok(u <= 0.915, `${file} column ${col.n} reaches ${u.toFixed(3)}`);
      }
    }
  });

  it('asks IIIF for that crop', () => {
    assert.equal(cropUrl('https://x/y', [1, 2, 880, 1000], 500), 'https://x/y/1,2,880,1000/500,/0/default.jpg');
    assert.equal(cropUrl('https://x/y', [1, 2, 88, 100]), 'https://x/y/1,2,88,100/88,/0/default.jpg');
  });

  it('puts each line where the photograph has it', () => {
    const doc = read('021A');
    const layout = layoutFolio(doc);
    assert.equal(layout.registered, true);
    assert.equal(layout.columns.length, 3);
    const [, cy, , ch] = layout.crop;
    // Gen 34:12 fills line 3 of column 1 and has a zone for it.
    const seg = doc.facsimile.zones['Gen 34:12'].segments[2];
    const line = layout.columns[0].lines.find((l) => l.n === '3');
    near(line.y, ((seg[1] + seg[3]) / 2 - cy) / ch, layout.columns[0].pitch * 0.5);
  });

  it('sets columns right to left and lines top to bottom', () => {
    const { columns } = layoutFolio(read('021A'));
    assert.ok(columns[0].left > columns[1].right);
    assert.ok(columns[1].left > columns[2].right);
    for (const c of columns) assert.ok(c.lines.every((l, i) => i === 0 || l.y > c.lines[i - 1].y));
  });

  it('falls back to an even grid for the side with no zones', () => {
    const layout = layoutFolio(read('089B'));
    assert.equal(layout.registered, false);
    assert.ok(layout.columns.length >= 1);
    for (const c of layout.columns) for (const l of c.lines) assert.ok(l.y > 0 && l.y < 1);
  });

  it('spaces a verse across lines and sides', () => {
    const word = (text, kind = 'w') => ({ text, kind, marks: [], verse: 'Gen 1:1' });
    const doc = (tokens) => ({ columns: [{ n: '1', lines: [{ n: '1', tokens, marks: [] }] }] });
    const other = { text: 'x', kind: 'w', marks: [], verse: 'Gen 1:2' };
    const text = verseText([doc([word('אל־'), word('הארץ')]), doc([other, word('טוב'), word('׃', 'sof-pasuq')])], 'Gen 1:1');
    assert.equal(text, 'אל־הארץ טוב׃');
  });

  it('justifies only a full line', () => {
    assert.equal(justifySpacing(90, 100, 2, 16, false), 5);
    assert.equal(justifySpacing(90, 100, 2, 16, true), 0);
    assert.equal(justifySpacing(50, 100, 2, 16, false), 0);
    assert.equal(justifySpacing(101, 100, 2, 16, false), 0);
    assert.equal(justifySpacing(90, 100, 0, 16, false), 0);
    assert.equal(justifySpacing(75, 100, 1, 16, false), 0);
  });
});

describe('theme colors', () => {
  it('reads the color forms that the global style sheet uses', () => {
    assert.deepEqual(parseColor('#ffffff'), [1, 1, 1, 1]);
    assert.deepEqual(parseColor(' #000 '), [0, 0, 0, 1]);
    assert.deepEqual(parseColor('rgba(255, 0, 0, 0.45)'), [1, 0, 0, 0.45]);
    assert.deepEqual(parseColor('rgb(0 255 0)'), [0, 1, 0, 1]);
    assert.deepEqual(parseColor('rgb(0 255 0 / 50%)'), [0, 1, 0, 0.5]);
  });

  it('reads the short forms that the CSS minifier writes', () => {
    const [r, g, b, a] = parseColor('#3c28142e');
    near(r, 60 / 255);
    near(g, 40 / 255);
    near(b, 20 / 255);
    near(a, 0.18, 0.005);
    assert.deepEqual(parseColor('#f008'), [1, 0, 0, 0x88 / 255]);
  });

  it('reads every color token the book uses from the global style sheet', () => {
    const css = readFileSync(join(here, '..', 'src', 'styles', 'global.css'), 'utf8');
    const source = readFileSync(join(here, '..', 'src', 'lib', 'codex', 'theme.ts'), 'utf8');
    const tokens = [...source.matchAll(/token\('(--[a-z-]+)'\)/g)].map((m) => m[1]);
    assert.ok(tokens.length > 0);
    for (const name of tokens) assert.ok(css.includes(`${name}:`), `${name} is not in global.css`);
  });

  it('keeps the colors of the paper out of the dark theme', () => {
    const css = readFileSync(join(here, '..', 'src', 'styles', 'global.css'), 'utf8');
    const definitions = [...css.matchAll(/^\s*(--page-[a-z-]+):/gm)].map((m) => m[1]);
    assert.ok(definitions.length > 0);
    assert.equal(new Set(definitions).size, definitions.length, 'a --page-* token is set more than once');
  });

  it('gives an unknown color as opaque black, not a broken one', () => {
    assert.deepEqual(parseColor('color-mix(in srgb, red, blue)'), [0, 0, 0, 1]);
  });
});

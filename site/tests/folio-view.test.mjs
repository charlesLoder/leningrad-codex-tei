import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { folioCitation } from '../src/lib/citation.ts';
import {
  buildViewData,
  chapterAndVerse,
  hashToKey,
  isErasedLine,
  leafBounds,
  lineHtml,
  lineSummary,
  lineVerseNumbers,
  refKey,
  refToHash,
  searchFolios,
  verseNeighbors,
} from '../src/lib/folio-view.ts';
import { abbreviateRange, parseFolioXml } from '../src/lib/tei.ts';

const here = dirname(fileURLToPath(import.meta.url));
const editionDir = join(here, '..', '..', 'edition');
const read = (folio) => parseFolioXml(readFileSync(join(editionDir, `${folio}.xml`), 'utf8'));
const word = (text, verse, marks = []) => ({ text, kind: 'w', marks, verse });

describe('facsimile parsing', () => {
  it('reads the surface, image service, and verse zones', () => {
    const { facsimile } = read('021A');
    assert.equal(facsimile.width, 4479);
    assert.equal(facsimile.height, 5279);
    assert.match(facsimile.imageService, /^https:\/\/iiif\.archive\.org\/image\/iiif\/3\/.+\.jp2$/);
    assert.equal(facsimile.zones['Gen 34:11'].cert, 0.539);
    assert.deepEqual(facsimile.zones['Gen 34:12'].segments[0], [3126, 1284, 3354, 1444]);
  });

  it('leaves a folio with no zones empty', () => {
    const doc = read('089B');
    assert.deepEqual(doc.facsimile.zones, {});
    assert.equal(leafBounds(doc), null);
  });

  it('gives each zone the key of its verse', () => {
    const doc = read('369B');
    assert.ok(Object.keys(doc.facsimile.zones).length > 0);
    for (const ref of Object.keys(doc.facsimile.zones)) assert.ok(doc.verses.includes(ref), ref);
  });
});

describe('buildViewData', () => {
  const doc = read('021A');
  const prev = { folio: '020B', range: 'Genesis 33:5 – Genesis 34:11' };
  const next = { folio: '021B', range: 'Genesis 35:4 – Genesis 36:1' };
  const data = buildViewData(doc, { folio: '021A', version: 'v1', manifest: '/iiif/021A.json', prev, next });

  it('pairs each verse with its zone and lines', () => {
    const verse = data.verses.find((v) => v.ref === 'Gen 34:25');
    assert.equal(verse.cert, 0.979);
    assert.equal(lineSummary(verse.lines), 'Column 2, lines 16–22');
    assert.equal(verse.segments.length, verse.lines.length);
  });

  it('finds the folios that a verse crosses into', () => {
    assert.deepEqual(verseNeighbors(data, 'Gen 34:11'), [{ label: 'Starts on', folio: '020B' }]);
    assert.deepEqual(verseNeighbors(data, 'Gen 35:4'), [{ label: 'Continues on', folio: '021B' }]);
    assert.deepEqual(verseNeighbors(data, 'Gen 34:25'), []);
  });

  it('keeps the leaf inside the photo and around every zone', () => {
    const [x, y, w, h] = data.leaf;
    assert.ok(x >= 0 && y >= 0 && x + w <= doc.facsimile.width && y + h <= doc.facsimile.height);
    for (const zone of Object.values(doc.facsimile.zones)) {
      for (const s of zone.segments) assert.ok(s[0] >= x && s[1] >= y && s[2] <= x + w && s[3] <= y + h);
    }
  });
});

describe('lineHtml', () => {
  it('groups words by verse and marks where each verse starts', () => {
    const html = lineHtml({
      n: '1',
      marks: [],
      tokens: [
        word('א', 'Gen 1:1'),
        { text: '׃', kind: 'sof-pasuq', marks: [], verse: 'Gen 1:1' },
        word('ב', 'Gen 1:2', [{ kind: 'verse', ref: 'Gen 1:2' }]),
      ],
    });
    assert.equal(
      html,
      '<span class="verse-run" data-verse="Gen 1:1">א<span class="sof-pasuq">׃</span></span> ' +
        '<span class="verse-run" data-verse="Gen 1:2">ב</span>',
    );
  });

  it('adds no space after a maqaf', () => {
    const html = lineHtml({ n: '1', marks: [], tokens: [word('את־', 'Gen 1:1'), word('כל', 'Gen 1:1')] });
    assert.match(html, /את־כל/);
  });

  it('keeps a paragraph mark on a line with no words', () => {
    assert.match(lineHtml({ n: '9', tokens: [], marks: [{ kind: 'section', subtype: 'pe' }] }), /section-tag.*פ/);
  });

  const erasure = (text, illegible = false) => ({ text, kind: 'erasure', marks: [], verse: null, illegible });

  it('strikes through erased words outside the verse runs', () => {
    const html = lineHtml({ n: '13', marks: [], tokens: [word('פה', 'Judg 18:3'), erasure('ויאמר')] });
    assert.equal(
      html,
      '<span class="verse-run" data-verse="Judg 18:3">פה</span> ' +
        '<span class="erasure"><del class="erased-text" title="Erased by the scribe">ויאמר</del></span>',
    );
  });

  it('splits a verse run around an erasure', () => {
    const html = lineHtml({ n: '1', marks: [], tokens: [word('א', 'Gen 1:1'), erasure('', true), word('ב', 'Gen 1:1')] });
    assert.equal((html.match(/class="verse-run"/g) ?? []).length, 2);
    assert.match(html, /<span class="erased-gap" role="img" aria-label="Erased text that cannot be read"/);
  });

  it('fills a line that has only an illegible erasure', () => {
    const l = { n: '4', marks: [], tokens: [erasure('', true)] };
    assert.ok(isErasedLine(l));
    assert.match(lineHtml(l), /class="erased-gap whole"/);
    assert.ok(!isErasedLine({ n: '5', marks: [], tokens: [erasure('', true), word('א', 'Gen 1:1')] }));
  });

  it('draws a gap before the words when the TEI has it first', () => {
    const token = { ...erasure('אשר', true), parts: [null, 'אשר'] };
    const html = lineHtml({ n: '1', marks: [], tokens: [token] });
    assert.ok(html.indexOf('erased-gap') < html.indexOf('erased-text'));
  });

  it('gives an erasure no verse number or verse line', () => {
    const l = { n: '1', marks: [], tokens: [erasure('מחשבות')] };
    assert.deepEqual(lineVerseNumbers(l), []);
  });
});

describe('verse gutter', () => {
  const start = (ref) => word('א', ref, [{ kind: 'verse', ref }]);
  const labels = (...refs) => lineVerseNumbers({ n: '1', marks: [], tokens: refs.map(start) }, 'Gen 34:11').map((v) => v.label);

  it('shows the chapter at verse 1 and at the first verse of the folio', () => {
    assert.deepEqual(labels('Gen 35:1'), ['35:1']);
    assert.deepEqual(labels('Gen 34:11'), ['34:11']);
    assert.deepEqual(labels('Gen 34:12'), ['12']);
  });

  it('lists two verses that start on a line, and makes more into a range', () => {
    assert.deepEqual(labels('Gen 34:12', 'Gen 34:13'), ['12', '13']);
    assert.deepEqual(labels('Gen 34:12', 'Gen 34:13', 'Gen 34:14'), ['12–14']);
  });

  it('skips a word that continues a verse', () => {
    assert.deepEqual(lineVerseNumbers({ n: '1', marks: [], tokens: [word('א', 'Gen 1:1')] }), []);
  });

  it('removes the book but keeps a numbered book whole', () => {
    assert.equal(chapterAndVerse('Gen 34:12'), '34:12');
    assert.equal(chapterAndVerse('1 Kgs 3:14'), '3:14');
  });
});

describe('verse links', () => {
  it('reads a hash in any spelling of the book', () => {
    assert.equal(hashToKey(refToHash('Gen 34:12')), refKey('Gen 34:12'));
    assert.equal(hashToKey('#exodus-3-14'), refKey('Exod 3:14'));
    assert.equal(hashToKey(refToHash('1 Sam 3:4')), refKey('1 Samuel 3:4'));
    assert.equal(hashToKey('#nothing'), null);
  });

  it('knows every book abbreviation that the edition shows', () => {
    const names = 'Genesis Exodus Leviticus Numbers Deuteronomy Joshua Judges Samuel_1 Samuel_2 Kings_1 Kings_2 Isaiah Jeremiah Ezekiel Hosea Joel Amos Obadiah Jonah Micah Nahum Habakkuk Zephaniah Haggai Zechariah Malachi Chronicles_1 Chronicles_2 Psalms Job Proverbs Ruth Song_of_Songs Ecclesiastes Lamentations Esther Daniel Ezra Nehemiah';
    for (const name of names.split(' ')) {
      const short = abbreviateRange(`${name} 1:1`);
      assert.notEqual(refKey(short), null, short);
      assert.equal(hashToKey(refToHash(short)), refKey(short), short);
    }
  });
});

describe('searchFolios', () => {
  const list = [
    ['032B', 'Exodus 2:22 – Exodus 3:17'],
    ['250A', 'Isaiah 1:1 – Isaiah 1:20'],
    ['409B', 'Job 42:7 – Job 42:17; Proverbs 1:1 – Proverbs 1:19'],
  ];

  it('links a verse to its folio with the verse in the hash', () => {
    const [hit] = searchFolios(list, 'Exod 3:14');
    assert.equal(hit.folio, '032B');
    assert.equal(hashToKey(new URL(hit.href, 'https://x/').hash), refKey('Exod 3:14'));
  });

  it('finds a folio by name, with no hash', () => {
    assert.deepEqual(searchFolios(list, '250a'), [{ folio: '250A', range: 'Isaiah 1:1 – Isaiah 1:20', href: '/folio/250A/' }]);
  });

  it('finds a folio that holds two books', () => {
    assert.equal(searchFolios(list, 'Prov 1:5')[0].folio, '409B');
  });

  it('returns nothing for an empty query or no match', () => {
    assert.deepEqual(searchFolios(list, '  '), []);
    assert.deepEqual(searchFolios(list, 'zzz'), []);
  });
});

it('folioCitation names the folio and its URL', () => {
  const text = folioCitation('021A', 'v1.1.0');
  assert.match(text, /"Folio 021A\."/);
  assert.match(text, /\(v1\.1\.0\)/);
  assert.match(text, /\/folio\/021A\/\.$/);
});

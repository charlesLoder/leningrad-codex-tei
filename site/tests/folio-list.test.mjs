import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countLabel, filterFolios, paginate } from '../src/lib/folio-list.ts';
import { folioRangeSpans } from '../src/lib/verses.ts';

const row = (folio, range) => ({
  folio,
  range,
  search: `${folio} ${range}`.toLowerCase(),
  spans: folioRangeSpans(range),
});

const rows = [
  row('001B', 'Genesis 1:1 – Genesis 1:26'),
  row('002A', 'Genesis 1:26 – Genesis 2:19'),
  row('050A', 'Exodus 3:1 – Exodus 3:20'),
];

describe('filterFolios', () => {
  it('returns every row for an empty query', () => {
    assert.equal(filterFolios(rows, '  ').length, 3);
  });

  it('matches by folio text', () => {
    assert.deepEqual(filterFolios(rows, '002a').map((r) => r.folio), ['002A']);
  });

  it('matches by verse overlap', () => {
    assert.deepEqual(filterFolios(rows, 'Gen 1:26').map((r) => r.folio), ['001B', '002A']);
    assert.deepEqual(filterFolios(rows, 'Exod 3').map((r) => r.folio), ['050A']);
  });

  it('returns nothing for a verse no row covers', () => {
    assert.equal(filterFolios(rows, 'Ruth 1:1').length, 0);
  });
});

describe('filterFolios on folios that cross a book', () => {
  // BOOKS has Proverbs before Job and Song before Ruth; the codex has the reverse.
  const crossing = [
    row('409B', 'Job 42:7 – Job 42:17; Proverbs 1:1 – Proverbs 1:19'),
    row('421A', 'Proverbs 31:23 – Proverbs 31:31; Ruth 1:1 – Ruth 1:17'),
    row('423A', 'Ruth 4:13 – Ruth 4:22; Song_of_Songs 1:1 – Song_of_Songs 2:5'),
    row('031B', 'Genesis 50:16 – Exodus 1:18'),
    row('133B', 'Joshua 21:32 – Joshua 21:35; Joshua 21:38 – Joshua 22:10'),
  ];
  const hits = (q) => filterFolios(crossing, q).map((r) => r.folio);

  it('finds both books of a folio', () => {
    assert.deepEqual(hits('Job 42:17'), ['409B']);
    assert.deepEqual(hits('Prov 1:1'), ['409B']);
    assert.deepEqual(hits('Ruth 4:22'), ['423A']);
    assert.deepEqual(hits('Song 1:1'), ['423A']);
  });

  it('does not match the books between them', () => {
    assert.deepEqual(hits('Prov 5:1'), []);
    assert.deepEqual(hits('Job 5:1'), []);
    assert.deepEqual(hits('Song 3:1'), []);
    assert.deepEqual(hits('Ruth 2:1'), []);
  });

  it('finds both sides of a book change with no semicolon', () => {
    assert.deepEqual(hits('Gen 50:26'), ['031B']);
    assert.deepEqual(hits('Exod 1:1'), ['031B']);
    assert.deepEqual(hits('Gen 49:1'), []);
    assert.deepEqual(hits('Exod 2:1'), []);
  });

  it('keeps the gap inside a range', () => {
    assert.deepEqual(hits('Josh 21:36'), []);
    assert.deepEqual(hits('Josh 21:38'), ['133B']);
  });
});

describe('paginate', () => {
  it('slices a full page', () => {
    assert.deepEqual(paginate(130, 2, 60), { page: 2, pages: 3, from: 60, to: 120 });
  });

  it('slices the last partial page', () => {
    assert.deepEqual(paginate(130, 3, 60), { page: 3, pages: 3, from: 120, to: 130 });
  });

  it('clamps out-of-range and invalid pages', () => {
    assert.equal(paginate(130, 9, 60).page, 3);
    assert.equal(paginate(130, 0, 60).page, 1);
    assert.equal(paginate(130, Number.NaN, 60).page, 1);
  });

  it('has one empty page when nothing matches', () => {
    assert.deepEqual(paginate(0, 1, 60), { page: 1, pages: 1, from: 0, to: 0 });
  });
});

describe('countLabel', () => {
  it('shows the visible range of all folios', () => {
    assert.equal(countLabel(paginate(259, 2, 60), 259, ''), '61–120 of 259 folios');
  });

  it('names the query when filtering', () => {
    assert.equal(countLabel(paginate(1, 1, 60), 1, ' 002a '), '1–1 of 1 folio matching “002a”');
  });

  it('reports no matches', () => {
    assert.equal(countLabel(paginate(0, 1, 60), 0, 'zzz'), 'No published folio matches “zzz”.');
  });
});

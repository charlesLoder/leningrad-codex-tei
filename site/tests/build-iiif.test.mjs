import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildManifest, formatRef } from '../scripts/build-iiif.mjs';

// The same shape that `scripts/zones.py add` writes. Zones are hand edits, so
// the tests do not depend on a folio in edition/ having them.
const ARCHIVE = 'https://iiif.archive.org/image/iiif/3/Leningrad_Codex_Color_0001.jp2';
const tei001B = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <facsimile>
    <surface xml:id="f001B-surface" ulx="0" uly="0" lrx="4239" lry="5231">
      <graphic xml:id="f001B-img" url="https://example.invalid/001B.jpg"/>
      <graphic xml:id="f001B-img-archive" url="${ARCHIVE}/full/max/0/default.jpg" width="4239px" height="5231px"/>
      <zone xml:id="f001B-zone-Genesis-1-1" type="verse" cert="0.9" resp="#source-masoretica">
        <zone xml:id="f001B-zone-Genesis-1-1-s1" ulx="2800" uly="1000" lrx="3500" lry="1100"/>
      </zone>
      <zone xml:id="f001B-zone-Genesis-1-10" type="verse" cert="0.9" resp="#source-masoretica">
        <zone xml:id="f001B-zone-Genesis-1-10-s1" ulx="2800" uly="4800" lrx="3500" lry="4900"/>
        <zone xml:id="f001B-zone-Genesis-1-10-s2" ulx="1800" uly="1000" lrx="2500" lry="1100"/>
      </zone>
    </surface>
  </facsimile>
</TEI>`;

test('formatRef turns milestone @n into a reference', () => {
  assert.equal(formatRef('Genesis-1-10'), 'Genesis 1:10');
  assert.equal(formatRef('Kings_1-21-10'), '1 Kings 21:10');
  assert.equal(formatRef('Song_of_Songs-1-1'), 'Song of Songs 1:1');
});

test('buildManifest paints the Archive.org image and one annotation per verse', () => {
  const { manifest } = buildManifest('001B', tei001B);
  const [canvas] = manifest.items;
  assert.equal(canvas.width, 4239);
  assert.equal(canvas.height, 5231);

  const body = canvas.items[0].items[0].body;
  assert.equal(body.id, `${ARCHIVE}/full/max/0/default.jpg`);
  assert.equal(body.service[0].type, 'ImageService3');

  const annos = canvas.annotations[0].items;
  assert.equal(annos.length, 2);
  assert.equal(annos[0].body.value, 'Genesis 1:1');
  assert.equal(annos[1].body.value, 'Genesis 1:10');
  assert.ok(annos[0].id.endsWith('/annotation/f001B-zone-Genesis-1-1'));
  // Genesis 1:10 crosses a column break: one annotation, two targets.
  const v10 = annos.find((a) => a.body.value === 'Genesis 1:10');
  assert.equal(v10.target.length, 2);
  assert.equal(v10.target[0].selector.type, 'SvgSelector');
});

test('buildManifest skips a folio without the Archive.org graphic', () => {
  const tei = tei001B.replace(/<graphic xml:id="f001B-img-archive"[^>]*\/>/, '');
  assert.equal(buildManifest('001B', tei), null);
});

test('buildManifest credits Masoretica and the photographers in a requiredStatement', () => {
  const { manifest } = buildManifest('001B', tei001B);
  assert.deepEqual(manifest.requiredStatement.label, { en: ['Attribution'] });
  assert.match(manifest.requiredStatement.value.en[0], /Masoretica/);
  assert.match(manifest.requiredStatement.value.en[0], /Idan Dershowitz/);
  assert.match(
    manifest.requiredStatement.value.en[1],
    /Bruce Zuckerman, West Semitic Research, with the collaboration of the Ancient Biblical Manuscript Center/,
  );
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFolioXml } from '../src/lib/tei.ts';

const here = dirname(fileURLToPath(import.meta.url));
const editionDir = join(here, '..', '..', 'edition');

describe('parseFolioXml', () => {
  it('parses a real folio from edition/', () => {
    const xml = readFileSync(join(editionDir, '002A.xml'), 'utf8');
    const doc = parseFolioXml(xml);
    assert.equal(doc.title, 'Leningrad Codex — 002A (Genesis 1:26 – Genesis 2:19)');
    assert.equal(
      doc.graphicUrl,
      'https://manuscripts.sefaria.org/leningrad-color/BIB_LENCDX_F002A.jpg',
    );
    assert.equal(doc.columns.length, 3);
    assert.ok(doc.verses.includes('Gen 1:26'));
    assert.ok(doc.verses.includes('Gen 2:19'));
    const firstToken = doc.columns[0].lines[0].tokens[0];
    assert.equal(firstToken.text, 'וּבְעֹ֣וף');
    assert.equal(firstToken.verse, 'Gen 1:26');
  });

  it('tolerates extra attributes, reordered attributes, and extra header children', () => {
    // Mirrors the index.xml `when`/`contributor` outage: new attributes or
    // children must not break parsing.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader>
    <fileDesc>
      <titleStmt>
        <title>Leningrad Codex — 099X (Genesis 1:1 – Genesis 1:2)</title>
        <respStmt xml:id="contrib-x" when="2026-09-18T04:37:25Z" contributor="Someone">
          <resp>TEI encoding</resp>
          <persName ref="mailto:x@example.com">X</persName>
          <date when="2026-09-18T04:37:25Z"/>
        </respStmt>
      </titleStmt>
    </fileDesc>
  </teiHeader>
  <facsimile>
    <surface xml:id="s">
      <graphic type="facsimile" xml:id="g1" url="https://example.test/f.jpg" when="2026-01-01" contributor="X"/>
    </surface>
  </facsimile>
  <text>
    <body>
      <div n="1" xml:id="ed1" type="edition" when="2026-01-01">
        <pb n="099X" xml:id="pb" contributor="X"/>
        <ab>
          <cb contributor="X" when="2026-01-01" n="1" xml:id="cb1"/>
          <lb xml:id="lb1" contributor="X" n="1"/>
          <milestone xml:id="v1" contributor="X" n="Genesis-1-1" unit="verse" when="2026-01-01"/>
          <w xml:id="w1" lemma="X" morph="noun" contributor="X">בְּרֵאשִׁ֖ית</w>
          <pc xml:id="pc1" contributor="X" type="sof-pasuq">׃</pc>
          <milestone unit="section" subtype="samekh" xml:id="s1" when="2026-01-01" contributor="X"/>
        </ab>
      </div>
    </body>
  </text>
</TEI>`;
    const doc = parseFolioXml(xml);
    assert.equal(doc.title, 'Leningrad Codex — 099X (Genesis 1:1 – Genesis 1:2)');
    assert.equal(doc.graphicUrl, 'https://example.test/f.jpg');
    assert.equal(doc.columns.length, 1);
    assert.deepEqual(doc.verses, ['Gen 1:1']);
    const line = doc.columns[0].lines[0];
    assert.equal(line.n, '1');
    assert.equal(line.tokens.length, 2);
    assert.equal(line.tokens[0].text, 'בְּרֵאשִׁ֖ית');
    assert.equal(line.tokens[0].verse, 'Gen 1:1');
    assert.equal(line.tokens[1].kind, 'sof-pasuq');
    assert.equal(line.tokens[1].marks.filter((m) => m.kind === 'section').length, 1);
  });

  it('handles whitespace/self-closing variations and nested markup in w', () => {
    const xml = `<TEI xmlns="http://www.tei-c.org/ns/1.0">
  <teiHeader><fileDesc><titleStmt><title>T</title></titleStmt></fileDesc></teiHeader>
  <facsimile><surface><graphic url="https://example.test/g.jpg" /></surface></facsimile>
  <text><body><div
    type="edition">
      <cb
        n="1" />
      <lb
        n="7"  />
      <milestone unit="verse" n="Genesis-1-2"></milestone>
      <w xml:id="w1">a<seg>b</seg>c</w>
      <pc type="paseq" xml:id="p1" >׀</pc>
    </div></body></text>
</TEI>`;
    const doc = parseFolioXml(xml);
    assert.equal(doc.columns.length, 1);
    assert.equal(doc.columns[0].lines[0].n, '7');
    assert.equal(doc.columns[0].lines[0].tokens[0].text, 'abc');
    assert.equal(doc.columns[0].lines[0].tokens[1].kind, 'paseq');
    assert.deepEqual(doc.verses, ['Gen 1:2']);
  });
});

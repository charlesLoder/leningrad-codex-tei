import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(here, '..');
const repoRoot = join(siteRoot, '..');
const editionDir = join(repoRoot, 'edition');
const publicDir = join(siteRoot, 'public', 'edition');
const dataFile = join(siteRoot, 'src', 'data', 'folios.json');

mkdirSync(publicDir, { recursive: true });
mkdirSync(dirname(dataFile), { recursive: true });

const files = readdirSync(editionDir).filter((f) => f.endsWith('.xml') && f !== 'index.xml');

for (const f of files) {
  cpSync(join(editionDir, f), join(publicDir, f));
}
cpSync(join(editionDir, 'index.xml'), join(publicDir, 'index.xml'));

const indexXml = readFileSync(join(editionDir, 'index.xml'), 'utf8');
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' });
const parsed = parser.parse(indexXml);
const rawEntries = parsed?.index?.entry ?? [];
const entryList = Array.isArray(rawEntries) ? rawEntries : [rawEntries];
const entries = entryList
  .filter((e) => e?.folio && e?.href && e?.title)
  .map((e) => ({
    folio: String(e.folio),
    href: String(e.href),
    title: String(e.title),
    range: String(e.title).replace(/^Leningrad Codex — \S+ \((.+)\)$/, '$1'),
  }));

const byFolio = new Map(entries.map((e) => [e.folio, e]));
for (const f of files) {
  const folio = f.replace(/\.xml$/, '');
  if (!byFolio.has(folio)) {
    byFolio.set(folio, { folio, href: f, title: `Leningrad Codex — ${folio}`, range: '' });
  }
}
const folios = [...byFolio.values()].sort((a, b) => a.folio.localeCompare(b.folio));

writeFileSync(dataFile, JSON.stringify(folios, null, 2) + '\n');

function versionFromPyproject() {
  const toml = readFileSync(join(repoRoot, 'pyproject.toml'), 'utf8');
  const match = toml.match(/^version\s*=\s*"([^"]+)"/m);
  if (!match) {
    throw new Error('version not found in pyproject.toml ([project] version)');
  }
  return match[1].trim();
}

// Single source of truth: root pyproject.toml [project].version.
// Git tags are not used here on purpose: Netlify build checkouts may be
// shallow, pinned to a branch, or missing tags, which previously produced
// stale versions (e.g. v0.1.0 during a v0.2.1 deploy).
let bare = versionFromPyproject();
bare = bare.replace(/^v/, '');
if (!/^\d+\.\d+\.\d+/.test(bare)) {
  console.error(`Invalid version "${bare}" (expected semver like 0.2.1 in pyproject.toml)`);
  process.exit(1);
}
const version = `v${bare}`;
writeFileSync(join(siteRoot, 'src', 'data', 'meta.json'), JSON.stringify({ version }, null, 2) + '\n');
console.log(`Synced ${folios.length} folios to public/edition + src/data/folios.json (version ${version} from pyproject.toml)`);

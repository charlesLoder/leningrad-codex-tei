import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const entries = [...indexXml.matchAll(/<entry\s+folio="([^"]+)"\s+href="([^"]+)">\s*<title>([^<]+)<\/title>/g)].map((m) => ({
  folio: m[1],
  href: m[2],
  title: m[3],
  range: m[3].replace(/^Leningrad Codex — \S+ \((.+)\)$/, '$1'),
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

let version = null;
try {
  version = execSync('git describe --tags --abbrev=0', { cwd: repoRoot, encoding: 'utf8' }).trim() || null;
} catch {
  version = null;
}
writeFileSync(join(siteRoot, 'src', 'data', 'meta.json'), JSON.stringify({ version }, null, 2) + '\n');
console.log(`Synced ${folios.length} folios to public/edition + src/data/folios.json${version ? ` (version ${version})` : ''}`);

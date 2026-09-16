export const CITATION = {
  author: 'Leningrad Codex TEI contributors',
  title: 'Leningrad Codex TEI',
  year: '2026',
  siteUrl: 'https://leningrad-codex-tei.netlify.app',
} as const;

export function bibliographyEntry(version?: string | null): string {
  const v = version ? ` (${version})` : '';
  return `${CITATION.author}. ${CITATION.title}${v}. ${CITATION.year}. ${CITATION.siteUrl}.`;
}

export function risRecord(version?: string | null): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  const accessed = `${now.getFullYear()}/${pad(now.getMonth() + 1)}/${pad(now.getDate())}/`;
  const lines = [
    'TY  - ELEC',
    `AU  - ${CITATION.author}`,
    `PY  - ${CITATION.year}`,
    `DA  - ${accessed}`,
    `TI  - ${CITATION.title}`,
    `UR  - ${CITATION.siteUrl}`,
  ];
  if (version) lines.push(`VL  - ${version}`);
  lines.push('ER  - ', '');
  return lines.join('\n');
}

import type { APIRoute } from 'astro';

const BODY = `# Leningrad Codex TEI

> The Leningrad Codex (Firkovich B 19 A, National Library of Russia) encoded as TEI XML. One TEI document per folio side, openly licensed (MIT), with a human-readable viewer on this site.

## Goals

- Accessibility: open, permissively licensed (MIT) TEI on GitHub, plus a ready-to-use download and a web viewer.
- Transparency: the generation process, including AI use, is documented in git history, TEI headers (facsimile URL and sha256, model and parameters, prompt commit), and the published pipeline and prompts.
- Reproducibility: the pipeline that generated the edition is published and configurable to other models and inference strategies.
- Community: unaffiliated, community-driven project. See the contributing guide in the repository.

## Site structure

- / lists every folio side with a client-side filter (human use).
- /folio/Fxxx[A|B]/ renders one folio side as columns and lines, with verse milestones, samekh/pe divisions, sof-pasuq and paseq inline (human use). A = recto, B = verso.
- /edition/ serves the raw TEI XML (machine use; see below).

Each folio document encodes the main biblical text only (ketiv consonantal text as written), laid out in columns and lines, with verse milestones marking where each verse begins and samekh/pe paragraph-division markers. Per-word biblical references are derived at index time, not stored per word.

## Valid folio numbers

- Format: Fxxx[A|B], zero-padded number plus side (A = recto, B = verso). Example: 001B, 002A, 463A.
- Full codex spans 001B through 463A (924 sides): 001B only (no 001A), 002A through 462B on both sides, 463A only (no 463B).
- The edition is published incrementally: only folios listed in /edition/index.xml exist as /edition/{FOLIO}.xml and /folio/{FOLIO}/ pages. Never guess a folio URL; read the manifest first.

## Agents: do not scrape this site

You never need to crawl the HTML viewer. Work directly with the XML files instead. They are the edition; the HTML is only a rendering of them.

- Manifest of all folio sides: /edition/index.xml (entry elements with folio, href, title, and passage range)
- Single folio side, TEI XML: /edition/{FOLIO}.xml (for example /edition/001B.xml)
- Whole edition as one zip (ready-to-use bundle, shipped with every release): https://github.com/charlesLoder/leningrad-codex-tei/releases/latest/download/leningrad-codex.zip
- Source repository and pipeline: https://github.com/charlesLoder/leningrad-codex-tei (generated files live in edition/)

Examples:

curl https://leningrad-codex-tei.netlify.app/edition/index.xml
curl https://leningrad-codex-tei.netlify.app/edition/001B.xml -o 001B.xml
curl -L https://github.com/charlesLoder/leningrad-codex-tei/releases/latest/download/leningrad-codex.zip -o leningrad-codex.zip

## License

MIT. Generate from the pipeline or redistribute freely; the TEI headers record provenance per folio.
`;

export const GET: APIRoute = () => {
  return new Response(BODY, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};

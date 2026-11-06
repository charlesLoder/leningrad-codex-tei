import folios from '../data/folios.json';

/** The folio list for the go-to search, fetched only when a reader opens it. */
export function GET(): Response {
  return new Response(JSON.stringify(folios.map((f) => [f.folio, f.range])), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

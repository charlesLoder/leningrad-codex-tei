/** The URL hash of the Codex view. This has no imports, because the small-screen message uses it without the book. */

export interface CodexRoute {
  side: string | null;
  /** The verse part of the hash, e.g. `Gen-34-12`. */
  verse: string | null;
}

/** `#021A` or `#021A/Gen-34-12`. */
export function parseRoute(hash: string): CodexRoute {
  const m = decodeURIComponent(hash.replace(/^#/, '')).match(/^(\d{3}[AB])(?:\/(.+))?$/);
  return m ? { side: m[1], verse: m[2] ?? null } : { side: null, verse: null };
}

/** A go-to hit links to the folio page. Inside the book, the same hit opens the book at that folio. */
export function folioHrefToRoute(href: string): string {
  const m = href.match(/^\/folio\/(\d{3}[AB])\/(?:#(.+))?$/);
  if (!m) return '#';
  return m[2] ? `#${m[1]}/${m[2]}` : `#${m[1]}`;
}

/** The folio page for a route, for a screen too small for the book. */
export function routeToFolioHref(route: CodexRoute, fallbackSide: string): string {
  const side = route.side ?? fallbackSide;
  return route.side && route.verse ? `/folio/${side}/#${route.verse}` : `/folio/${side}/`;
}

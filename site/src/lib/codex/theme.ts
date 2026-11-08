/**
 * The colors of the site's theme for the WebGL scene, which cannot use CSS variables.
 * The tokens live in `src/styles/global.css`, and these names map them onto the book.
 * The paper and its ink use the `--page-*` tokens, which stay the same in every theme.
 */
export type Rgba = [number, number, number, number];

/**
 * A color token to shares of 1, in every form it can take. The build's CSS minifier
 * rewrites `rgba(60, 40, 20, 0.18)` as `#3c28142e`, so the short forms matter.
 * Anything else is opaque black.
 */
export function parseColor(value: string): Rgba {
  const css = value.trim();
  const hex = css.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join('') : hex;
    const channels = [0, 2, 4, 6].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
    return [channels[0], channels[1], channels[2], full.length === 8 ? channels[3] : 1];
  }
  const parts = css.match(/^rgba?\(([^)]+)\)$/i)?.[1].split(/[\s,/]+/).filter(Boolean);
  if (parts && parts.length >= 3) {
    const alpha = parts[3] ?? '1';
    const color: Rgba = [Number(parts[0]) / 255, Number(parts[1]) / 255, Number(parts[2]) / 255, alpha.endsWith('%') ? parseFloat(alpha) / 100 : Number(alpha)];
    if (color.every(Number.isFinite)) return color;
  }
  return [0, 0, 0, 1];
}

export interface Theme {
  desk: Rgba;
  leaf: Rgba;
  edge: Rgba;
  board: Rgba;
  ink: Rgba;
  /** The shadow of the book on the desk. */
  shade: Rgba;
  /** The shadow of a turning leaf on the paper. */
  pageShade: Rgba;
  zone: Rgba;
}

export function readTheme(root: Element): Theme {
  const style = getComputedStyle(root);
  const token = (name: string) => parseColor(style.getPropertyValue(name));
  return {
    desk: token('--bg'),
    leaf: token('--page-bg'),
    edge: token('--page-edge'),
    board: token('--plate'),
    ink: token('--page-ink'),
    shade: token('--leaf-shadow'),
    pageShade: token('--page-shadow'),
    zone: token('--zone'),
  };
}

/**
 * The book drawn with WebGL2. Each page is a real DOM element inside the canvas,
 * sent to a texture with the HTML-in-Canvas API. `updateElementGeometry` then tells
 * the browser where the element was drawn, so that selection, find-in-page, and hover
 * work on the 3D page.
 */
import {
  BEND,
  BLOCK,
  BOARD,
  clamp,
  fitBox,
  foreEdgeReach,
  hitPlane,
  invert,
  leafShadow,
  type Mat4,
  multiply,
  PAGE_H,
  PAGE_W,
  PAGE_Z,
  pageHomography,
  project,
  REST_PITCH,
  ROOT_LAG,
  stackDepths,
  viewProjection,
} from './math.ts';
import { readTheme, type Theme } from './theme.ts';
import { type BookView, type PagePoint, pageElementSize, type Scene } from './view.ts';

/* The parts of the HTML-in-Canvas API that this view uses, as Chrome 157 has them. */
interface DrawableCanvas extends HTMLCanvasElement {
  requestPaint(): void;
  updateElementGeometry(element: Element, options: { canvasTransform: DOMMatrix }): void;
  clearElementGeometry(element: Element): void;
  getElementImageDefaultSize(element: Element): { width: number; height: number };
}
interface ElementTexturing {
  texElementSubImage2D(target: number, level: number, xoffset: number, yoffset: number, element: Element): void;
}
interface PaintEvent extends Event {
  readonly changedElements: readonly Element[];
}

/**
 * True only where WebGL can draw an element and hit testing follows it. Chrome 156
 * has the same methods behind a flag, but its hit testing ignores the geometry, and
 * it still has the old `texElementImage2D`, which Chrome 157 removed.
 */
export function supportsDrawableWebGL(): boolean {
  if (typeof WebGL2RenderingContext === 'undefined' || typeof HTMLCanvasElement === 'undefined') return false;
  const gl = WebGL2RenderingContext.prototype;
  const canvas = HTMLCanvasElement.prototype;
  return (
    'texElementSubImage2D' in gl &&
    !('texElementImage2D' in gl) &&
    'updateElementGeometry' in canvas &&
    'clearElementGeometry' in canvas &&
    'getElementImageDefaultSize' in canvas
  );
}

const PAGE_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec2 aUV;
uniform mat4 uVP;
uniform float uSide;
uniform int uIsLeaf;
uniform float uT, uGrip;
out vec3 vP;
out vec3 vN;
out vec2 vUV;
const float PI = 3.14159265;
const float PW = ${PAGE_W.toFixed(4)};
const float Z = ${PAGE_Z.toFixed(4)};
const float BENDING = ${BEND.toFixed(4)};
const float LAG = ${ROOT_LAG.toFixed(4)};
void main() {
  float u = aUV.x, v = aUV.y;
  vUV = aUV;
  if (uIsLeaf == 1) {
    float s = sin(PI * uT);
    // The root lags to make up most of the curl, so neither it nor the free edge turns back. This is leafArc in math.ts.
    float wave = sin(2.0 * PI * uT);
    float bend = -BENDING * wave;
    float root = PI * (1.0 - uT) + LAG * wave + uGrip * (v - 0.5) * 0.55 * s;
    float phi = root + bend * u;
    float ax, az;
    if (abs(bend) < 0.001) {
      ax = u * cos(root);
      az = u * sin(root);
    } else {
      ax = (sin(phi) - sin(root)) / bend;
      az = (cos(root) - cos(phi)) / bend;
    }
    vP = vec3(PW * ax, 0.5 - v, Z + 0.0025 + PW * az);
    vN = vec3(sin(phi), 0.0, -cos(phi));
  } else {
    vP = vec3(uSide * PW * u, 0.5 - v, Z);
    vN = vec3(0.0, 0.0, 1.0);
  }
  gl_Position = uVP * vec4(vP, 1.0);
}`;

const LIGHT = `
// Even light from straight above, as on a scanner. A flat page comes out as its theme color, and only what bends changes.
float light(vec3 N) {
  return 0.72 + 0.28 * max(N.z, 0.0);
}`;

const PAGE_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vP;
in vec3 vN;
in vec2 vUV;
out vec4 fragColor;
uniform sampler2D uTile, uInkFront, uInkBack, uPhotoFront, uPhotoBack, uDetail;
// The sharp copy of part of a resting page: its place on the page as x0, y0, x1, y1, and how far it has faded in.
uniform vec4 uDetailRect;
uniform float uDetailOn;
uniform int uIsLeaf;
uniform float uSide, uSeed, uInkFrontOn, uInkBackOn, uPhotoFrontOn, uPhotoBackOn;
uniform float uFaux, uPhotoAll;
uniform vec3 uLens;
uniform vec3 uShadow;
uniform vec3 uLeafColor, uLeafEdge, uInkColor, uZone;
uniform vec4 uShade;
${LIGHT}

// A leaf that flies past in a riffle shows only the impression of writing.
float fauxText(vec2 uv, float grain) {
  float rows = abs(fract(uv.y * 27.0 + 0.5) - 0.5) * 2.0;
  float inRow = smoothstep(0.42, 0.2, rows);
  float cols = abs(fract((uv.x - 0.13) / 0.25) - 0.5) * 2.0;
  float block = step(0.14, uv.y) * step(uv.y, 0.84) * step(0.13, uv.x) * step(uv.x, 0.88) * smoothstep(0.95, 0.86, cols);
  return inRow * block * smoothstep(0.34, 0.62, grain) * 0.3;
}

void main() {
  bool back = uIsLeaf == 1 && !gl_FrontFacing;
  float side = uIsLeaf == 1 ? (back ? 1.0 : -1.0) : uSide;
  // The page element reads left to right, so a left page runs from the fore-edge to the spine.
  vec2 uv = vec2(side < 0.0 ? 1.0 - vUV.x : vUV.x, vUV.y);
  float seed = fract(uSeed * 0.61803) * 7.0;
  vec4 t = texture(uTile, uv * vec2(1.7, 1.95) + vec2(seed, seed * 1.37));
  vec3 N = normalize(uIsLeaf == 1 ? (gl_FrontFacing ? vN : -vN) : vec3(0.0, 0.0, 1.0));

  // The theme color with a trace of skin in it. Legibility comes first.
  vec3 skin = uLeafColor * (1.0 + (t.r - 0.5) * 0.028 + (t.g - 0.5) * 0.012);

  float lensD = length(vP.xy - uLens.xy);
  float lens = uLens.z > 0.0 ? 1.0 - smoothstep(uLens.z * 0.93, uLens.z, lensD) : 0.0;
  float rim = uLens.z > 0.0 ? smoothstep(uLens.z * 0.9, uLens.z * 0.97, lensD) * (1.0 - smoothstep(uLens.z * 0.97, uLens.z * 1.02, lensD)) : 0.0;
  // Every lookup stays outside any branch, because a lookup in a branch has no reliable mip level.
  vec4 photoFront = texture(uPhotoFront, uv);
  vec4 photoBack = texture(uPhotoBack, uv);
  vec4 inkFront = texture(uInkFront, uv, -0.4);
  vec4 inkBack = texture(uInkBack, uv, -0.4);
  float fauxGrain = texture(uTile, uv * vec2(6.0, 31.0) + seed).g;

  float photoOn = back ? uPhotoBackOn : uPhotoFrontOn;
  // The crop can hold a little of the photographer's background, so the edges melt into the skin.
  vec2 inner = smoothstep(vec2(0.0), vec2(0.035, 0.05), uv) * smoothstep(vec2(0.0), vec2(0.035, 0.03), 1.0 - uv);
  float reveal = max(uPhotoAll, lens) * photoOn * inner.x * inner.y;
  vec3 base = mix(skin, (back ? photoBack : photoFront).rgb, reveal);

  float inkOn = back ? uInkBackOn : uInkFrontOn;
  vec2 detailUv = (uv - uDetailRect.xy) / max(uDetailRect.zw - uDetailRect.xy, vec2(1e-5));
  vec4 inkDetail = texture(uDetail, clamp(detailUv, 0.0, 1.0));
  vec2 detailEdge = smoothstep(vec2(0.0), vec2(0.01), detailUv) * smoothstep(vec2(0.0), vec2(0.01), 1.0 - detailUv);
  float detailOn = uIsLeaf == 1 ? 0.0 : uDetailOn * detailEdge.x * detailEdge.y;
  vec4 ink = (back ? inkBack : mix(inkFront, inkDetail, detailOn)) * inkOn;
  if (inkOn < 1.0 && uPhotoAll < 0.5) {
    float faux = fauxText(uv, fauxGrain) * (1.0 - inkOn) * uFaux;
    ink = vec4(uInkColor * faux, faux) + ink;
  }
  // Under the lens the type turns into a ghost, to compare with the ink. With no photograph yet it stays as it is.
  ink *= 1.0 - lens * 0.8 * photoOn;
  vec3 color = base * (1.0 - ink.a) + ink.rgb;

  // The fold: a fine line where the two pages meet, and a trace of shade beside it. It fades as a leaf lifts.
  float fold = (0.34 * exp(-vUV.x * 320.0) + 0.06 * exp(-vUV.x * 60.0)) * abs(N.z);
  color *= light(N) * (1.0 - fold);
  // A bend takes on the theme's edge color, so a turning leaf also reads on a dark page.
  if (uIsLeaf == 1) color = mix(color, uLeafEdge, (1.0 - abs(N.z)) * 0.32);
  // The ring stays faint until there is a photograph to show.
  color = mix(color, uZone, rim * (0.25 + 0.6 * photoOn));

  // The turning leaf shades the pages under it.
  if (uIsLeaf == 0 && uShadow.z > 0.0) {
    // The band from the spine to the tip of the leaf. A leaf higher up casts a softer edge. There is no edge at the spine, so the shadow crosses it with no jump.
    float away = max(max(min(0.0, uShadow.x) - vP.x, vP.x - max(0.0, uShadow.x)), 0.0);
    float inside = 1.0 - smoothstep(0.0, 0.08 + uShadow.y * 0.5, away);
    color = mix(color, uShade.rgb, inside * uShadow.z * uShade.a * 0.6);
  }
  fragColor = vec4(color, 1.0);
}`;

const SOLID_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in vec3 aP;
layout(location=1) in vec3 aN;
uniform mat4 uVP;
out vec3 vP;
out vec3 vN;
void main() {
  vP = aP;
  vN = aN;
  gl_Position = uVP * vec4(aP, 1.0);
}`;

const SOLID_FS = `#version 300 es
precision highp float;
precision highp int;
in vec3 vP;
in vec3 vN;
out vec4 fragColor;
uniform int uKind;
uniform vec3 uShadowBox;
uniform vec3 uBoard, uEdge, uDesk;
uniform vec4 uShade;
${LIGHT}

float box(vec2 p, vec2 half_, float r) {
  vec2 d = abs(p) - half_ + r;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r;
}

void main() {
  vec3 N = normalize(vN);
  if (uKind == 0) {
    // The boards of the binding.
    fragColor = vec4(uBoard * light(N), 1.0);
  } else if (uKind == 3) {
    // The cradle under the boards.
    fragColor = vec4(mix(uBoard, uDesk, 0.55) * light(N), 1.0);
  } else if (uKind == 1) {
    // The edges of the leaves in the stack.
    float leaves = sin(vP.z * 1450.0) * 0.5 + 0.5;
    fragColor = vec4(uEdge * (0.94 + 0.08 * leaves) * light(N), 1.0);
  } else {
    // The desk is the page background, with the soft shadow of the book on it.
    float d = box(vP.xy, uShadowBox.xy, 0.05);
    float shadow = (1.0 - smoothstep(-0.04, uShadowBox.z, d)) * uShade.a * 1.6;
    fragColor = vec4(mix(uDesk, uShade.rgb, clamp(shadow, 0.0, 1.0)), 1.0);
  }
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram() as WebGLProgram;
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? 'shader');
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? 'program');
  return program;
}

type Uniforms = Record<string, WebGLUniformLocation | null>;
function uniforms(gl: WebGL2RenderingContext, program: WebGLProgram): Uniforms {
  const out: Uniforms = {};
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) out[info.name] = gl.getUniformLocation(program, info.name);
  }
  return out;
}

/** A square of smooth noise that tiles: broad variation in red and fine grain in green. */
function noiseTile(size = 256): Uint8Array {
  const octave = (cells: number, seed: number) => {
    const lattice = new Float32Array(cells * cells);
    let s = seed;
    for (let i = 0; i < lattice.length; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      lattice[i] = s / 4294967296;
    }
    return (x: number, y: number) => {
      const fx = (x / size) * cells;
      const fy = (y / size) * cells;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const a = fx - x0;
      const b = fy - y0;
      const sa = a * a * (3 - 2 * a);
      const sb = b * b * (3 - 2 * b);
      const at = (i: number, j: number) => lattice[(j % cells) * cells + (i % cells)];
      const top = at(x0, y0) * (1 - sa) + at(x0 + 1, y0) * sa;
      const bottom = at(x0, y0 + 1) * (1 - sa) + at(x0 + 1, y0 + 1) * sa;
      return top * (1 - sb) + bottom * sb;
    };
  };
  const broad = [octave(4, 11), octave(9, 23)];
  const fine = [octave(48, 41), octave(96, 53)];
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      out[i] = (broad[0](x, y) * 0.65 + broad[1](x, y) * 0.35) * 255;
      out[i + 1] = (fine[0](x, y) * 0.6 + fine[1](x, y) * 0.4) * 255;
      out[i + 3] = 255;
    }
  }
  return out;
}

interface GlPage {
  element: HTMLElement;
  texture: WebGLTexture;
  size: [number, number];
  /** The element has a new picture to send to the texture. */
  stale: boolean;
  uploaded: boolean;
  /** Fades the text in once it first arrives. */
  fade: number;
  photo: WebGLTexture | null;
  /** Kept to rebuild the texture if the WebGL context is lost. */
  photoImage: HTMLImageElement | null;
  /** A photograph that arrived while a leaf was moving, for the landing. */
  photoWaiting: boolean;
  photoFade: number;
  /** The last transform given to the browser, or null while the page is not hit testable. */
  geometry: string | null;
}

interface Mesh {
  vao: WebGLVertexArrayObject;
  count: number;
  buffer?: WebGLBuffer;
}

/**
 * A sharp copy of the part of a resting page that is on the screen. Zoomed in, the
 * page's own picture is too small, so the copy is laid out larger with CSS zoom and
 * drawn at the size of the screen. While it shows, it takes the pointer and the
 * selection in place of the page.
 */
interface GlDetail {
  /** The page element that it copies. */
  source: HTMLElement;
  box: HTMLElement;
  shift: HTMLElement;
  copy: HTMLElement;
  texture: WebGLTexture;
  size: [number, number];
  /** The part of the page that the box holds now. */
  plan: DetailPlan | null;
  /** The part of the page in the texture, as shares of the page: x0, y0, x1, y1. */
  shown: [number, number, number, number] | null;
  stale: boolean;
  /** How far it has faded in. */
  on: number;
  geometry: string | null;
}

/** A part of a page, in the page element's CSS pixels, and the zoom to lay it out at. */
interface DetailPlan {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** The part on the screen now, without the margin. */
  core: [number, number, number, number];
  scale: number;
}

/** Below this many screen pixels for each pixel of a page's picture, the picture is sharp enough. */
const DETAIL_FROM = 1.15;
const DETAIL_MOST_SCALE = 8;
/** The copy reaches this share past each edge of the view, so a short pan stays sharp. */
const DETAIL_MARGIN = 0.15;
/** The copy is drawn once the view has been still for this long. */
const DETAIL_WAIT = 180;

function pathOf(root: Node, node: Node): number[] | null {
  const path: number[] = [];
  for (let at: Node = node; at !== root; ) {
    const parent = at.parentNode;
    if (!parent) return null;
    path.unshift(Array.prototype.indexOf.call(parent.childNodes, at));
    at = parent;
  }
  return path;
}

function nodeAt(root: Node, path: number[]): Node | null {
  let at: Node | null = root;
  for (const i of path) at = at?.childNodes[i] ?? null;
  return at;
}

/** Moves a selection to the same text in a copy of the element that holds it. */
function mirrorSelection(from: Element, to: Element): void {
  const selection = getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
  const range = selection.getRangeAt(0);
  if (!from.contains(range.startContainer) || !from.contains(range.endContainer)) return;
  const startPath = pathOf(from, range.startContainer);
  const endPath = pathOf(from, range.endContainer);
  const start = startPath && nodeAt(to, startPath);
  const end = endPath && nodeAt(to, endPath);
  if (!start || !end) return;
  const next = document.createRange();
  try {
    next.setStart(start, range.startOffset);
    next.setEnd(end, range.endOffset);
  } catch {
    return;
  }
  selection.removeAllRanges();
  selection.addRange(next);
}

const PAGE_COLS = 56;
const PAGE_ROWS = 18;

export class GlView implements BookView {
  readonly surface: HTMLCanvasElement & DrawableCanvas;
  readonly canOrbit = true;
  readonly pageSize: { width: number; height: number };
  private readonly gl: WebGL2RenderingContext;
  private readonly texturing: WebGL2RenderingContext & ElementTexturing;
  private readonly pages = new Map<string, GlPage>();
  private readonly byElement = new Map<Element, GlPage>();
  private pageProgram!: WebGLProgram;
  private solidProgram!: WebGLProgram;
  private pageU: Uniforms = {};
  private solidU: Uniforms = {};
  private pageMesh!: Mesh;
  private boards!: Mesh;
  private desk!: Mesh;
  private block!: Mesh;
  private cradle!: Mesh;
  private tile!: WebGLTexture;
  private anisotropy: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;
  private scene: Scene | null = null;
  private vp: Mat4 = new Float64Array(16);
  private inverseVp: Mat4 = new Float64Array(16);
  private cssSize = { width: 1, height: 1 };
  private lost = false;
  private fitKey = '';
  private fitDist = 3;
  private fitShift = 0;
  private theme: Theme = readTheme(document.documentElement);
  private wasMoving = false;
  private readonly details = new Map<string, GlDetail>();
  private readonly detailByBox = new Map<Element, GlDetail>();
  private detailTimer = 0;
  private wantDetails = false;
  private viewKey = '';
  private maxTexture = 4096;
  /** Set when a texture arrives, so the controller draws one more frame. */
  onChange: () => void = () => {};

  constructor(host: HTMLElement) {
    const canvas = document.createElement('canvas') as HTMLCanvasElement & DrawableCanvas;
    canvas.setAttribute('content', 'drawable');
    canvas.className = 'codex-canvas';
    canvas.setAttribute('aria-label', 'Open book');
    canvas.setAttribute('role', 'group');
    host.append(canvas);
    this.surface = canvas;
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'high-performance' });
    if (!gl) {
      canvas.remove();
      throw new Error('WebGL2 is not available');
    }
    this.gl = gl;
    this.texturing = gl as WebGL2RenderingContext & ElementTexturing;
    this.pageSize = pageElementSize(devicePixelRatio);
    try {
      this.buildGl();
    } catch (error) {
      canvas.remove();
      throw error;
    }
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
    canvas.addEventListener('paint', (event) => this.onPaint(event as PaintEvent));
    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.lost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.buildGl();
      for (const page of this.pages.values()) {
        page.texture = this.newTexture();
        page.size = [0, 0];
        page.stale = true;
        page.uploaded = false;
        page.photo = page.photoImage ? this.photoTexture(page.photoImage) : null;
        page.photoWaiting = false;
      }
      for (const side of [...this.details.keys()]) this.dropDetail(side);
      this.viewKey = '';
      canvas.requestPaint();
      this.onChange();
    });
  }

  private buildGl(): void {
    const { gl } = this;
    this.pageProgram = compile(gl, PAGE_VS, PAGE_FS);
    this.solidProgram = compile(gl, SOLID_VS, SOLID_FS);
    this.pageU = uniforms(gl, this.pageProgram);
    this.solidU = uniforms(gl, this.solidProgram);
    this.pageMesh = this.buildPageMesh();
    const start = stackDepths(0);
    this.boards = this.buildSolid(boardVertices(start), gl.DYNAMIC_DRAW);
    this.cradle = this.buildSolid(cradleVertices(start), gl.DYNAMIC_DRAW);
    this.desk = this.buildSolid(quad(-12, 12, -12, 12, 0, [0, 0, 1]), gl.STATIC_DRAW);
    this.block = this.buildSolid(blockVertices(start), gl.DYNAMIC_DRAW);

    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    this.maxTexture = Math.min(8192, gl.getParameter(gl.MAX_TEXTURE_SIZE) as number);
    this.anisotropy = ext ? { ext, max: Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) } : null;
    this.tile = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, this.tile);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, noiseTile());
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  private buildPageMesh(): Mesh {
    const { gl } = this;
    const verts = new Float32Array((PAGE_COLS + 1) * (PAGE_ROWS + 1) * 2);
    let i = 0;
    for (let r = 0; r <= PAGE_ROWS; r++) {
      for (let c = 0; c <= PAGE_COLS; c++) {
        verts[i++] = c / PAGE_COLS;
        verts[i++] = r / PAGE_ROWS;
      }
    }
    const indices = new Uint16Array(PAGE_COLS * PAGE_ROWS * 6);
    i = 0;
    for (let r = 0; r < PAGE_ROWS; r++) {
      for (let c = 0; c < PAGE_COLS; c++) {
        const a = r * (PAGE_COLS + 1) + c;
        const b = a + 1;
        const d = a + PAGE_COLS + 1;
        const e = d + 1;
        // Counter-clockwise from above while the leaf lies on the left, so its front is the recto.
        indices.set([a, b, d, b, e, d], i);
        i += 6;
      }
    }
    const vao = gl.createVertexArray() as WebGLVertexArrayObject;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: indices.length };
  }

  private buildSolid(verts: Float32Array, usage: number): Mesh {
    const { gl } = this;
    const vao = gl.createVertexArray() as WebGLVertexArrayObject;
    const buffer = gl.createBuffer() as WebGLBuffer;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, usage);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.bindVertexArray(null);
    return { vao, count: verts.length / 6, buffer };
  }

  private newTexture(): WebGLTexture {
    const { gl } = this;
    const texture = gl.createTexture() as WebGLTexture;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.ext.TEXTURE_MAX_ANISOTROPY_EXT, this.anisotropy.max);
    return texture;
  }

  private resize(): void {
    const canvas = this.surface;
    const rect = { width: canvas.clientWidth, height: canvas.clientHeight };
    if (!rect.width || !rect.height) return;
    this.cssSize = rect;
    const ratio = Math.min(2, devicePixelRatio || 1);
    const width = Math.round(rect.width * ratio);
    const height = Math.round(rect.height * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    // A new canvas size can change the size of an element's picture.
    for (const page of this.pages.values()) page.stale = true;
    canvas.requestPaint();
    this.onChange();
  }

  refreshTheme(): void {
    this.theme = readTheme(document.documentElement);
  }

  addPage(side: string, element: HTMLElement): void {
    element.inert = true;
    element.setAttribute('aria-hidden', 'true');
    this.surface.append(element);
    const page: GlPage = {
      element,
      texture: this.newTexture(),
      size: [0, 0],
      stale: true,
      uploaded: false,
      fade: 0,
      photo: null,
      photoImage: null,
      photoWaiting: false,
      photoFade: 0,
      geometry: null,
    };
    this.pages.set(side, page);
    this.byElement.set(element, page);
    this.surface.requestPaint();
  }

  removePage(side: string): void {
    const page = this.pages.get(side);
    if (!page) return;
    this.dropDetail(side);
    this.gl.deleteTexture(page.texture);
    if (page.photo) this.gl.deleteTexture(page.photo);
    this.byElement.delete(page.element);
    this.pages.delete(side);
    page.element.remove();
  }

  setPhoto(side: string, image: HTMLImageElement): void {
    const page = this.pages.get(side);
    if (!page) return;
    page.photoImage = image;
    if (this.lost) return;
    // Uploading a photograph takes time, so while a leaf moves it waits its turn.
    if (this.moving) {
      page.photoWaiting = true;
      return;
    }
    this.showPhoto(page, image);
    this.onChange();
  }

  private showPhoto(page: GlPage, image: HTMLImageElement): void {
    // A sharper photograph takes the place of the preview with no fade.
    if (page.photo) this.gl.deleteTexture(page.photo);
    else page.photoFade = 0;
    page.photo = this.photoTexture(image);
    page.photoWaiting = false;
  }

  private get moving(): boolean {
    return (this.scene?.leaves.length ?? 0) > 0;
  }

  /**
   * While a leaf moves, a side that has a picture keeps it until the landing, when
   * nothing shows the time an upload takes. A side with no picture gets one at once if
   * the reader sees it. Otherwise it gets one per frame, to be ready for the next turn.
   */
  private uploadsNow(side: string, page: GlPage, spare: { uploads: number }): boolean {
    const { scene } = this;
    if (!scene || scene.leaves.length === 0) return true;
    if (page.uploaded) return false;
    if (side === scene.left || side === scene.right || scene.leaves.some((leaf) => side === leaf.front || side === leaf.back)) return true;
    return spare.uploads-- > 0;
  }

  /** Does what waited for the leaves, on the first frame after they land. */
  private afterLanding(): void {
    if (this.moving) {
      this.wasMoving = true;
      let photoShown = false;
      let paintAsked = false;
      for (const page of this.pages.values()) {
        // A run of turns may have no landing for a long time, so a page with no photograph gets one per frame.
        if (!photoShown && page.photoWaiting && page.photoImage && !page.photo) {
          this.showPhoto(page, page.photoImage);
          photoShown = true;
        }
        if (!paintAsked && page.stale && !page.uploaded) {
          this.surface.requestPaint();
          paintAsked = true;
        }
      }
      return;
    }
    if (!this.wasMoving) return;
    this.wasMoving = false;
    for (const page of this.pages.values()) {
      if (page.photoWaiting && page.photoImage) this.showPhoto(page, page.photoImage);
    }
    this.surface.requestPaint();
  }

  private photoTexture(image: HTMLImageElement): WebGLTexture {
    const { gl } = this;
    const texture = this.newTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    return texture;
  }

  private onPaint(event: PaintEvent): void {
    if (this.lost) return;
    for (const element of event.changedElements ?? []) {
      const page = this.byElement.get(element);
      if (page) page.stale = true;
      const detail = this.detailByBox.get(element);
      if (detail) detail.stale = true;
    }
    let any = false;
    const spare = { uploads: 1 };
    for (const [side, page] of this.pages) {
      if (page.stale && this.uploadsNow(side, page, spare) && this.upload(page)) any = true;
    }
    // A sharp copy is large, so it waits for the leaves to land.
    if (!this.moving) {
      for (const detail of this.details.values()) if (detail.stale && this.uploadDetail(detail)) any = true;
    }
    if (any) {
      if (this.scene) this.draw(this.scene);
      this.onChange();
    }
  }

  private upload(page: GlPage): boolean {
    const { gl } = this;
    try {
      const size = this.surface.getElementImageDefaultSize(page.element);
      const width = Math.ceil(size.width);
      const height = Math.ceil(size.height);
      if (!width || !height) return false;
      gl.bindTexture(gl.TEXTURE_2D, page.texture);
      if (page.size[0] !== width || page.size[1] !== height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        page.size = [width, height];
      }
      // The shader blends premultiplied ink. Straight alpha would fatten light text on a dark page.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      this.texturing.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, page.element);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.generateMipmap(gl.TEXTURE_2D);
      page.stale = false;
      page.uploaded = true;
      return true;
    } catch {
      // The element has no picture yet. The next paint event tries again.
      return false;
    }
  }

  fit(pageOnly: boolean, insetBottom: number): number {
    const { width, height } = this.cssSize;
    const room = Math.max(0.3, 1 - insetBottom / height);
    const key = `${width}/${height}/${room}/${pageOnly}`;
    if (key !== this.fitKey) {
      const reach = PAGE_W + 0.06;
      const box = { x0: pageOnly ? -0.02 : -reach, x1: reach, y0: -PAGE_H / 2 - 0.03, y1: PAGE_H / 2 + 0.03, z0: 0, z1: PAGE_Z };
      const pose = { x: pageOnly ? PAGE_W / 2 : 0, y: 0, z: PAGE_Z, dist: 1, yaw: 0, pitch: REST_PITCH };
      const { dist, shiftY } = fitBox(pose, width / height, room, box);
      this.fitDist = dist;
      this.fitShift = shiftY;
      this.fitKey = key;
    }
    return this.fitDist;
  }

  worldAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.surface.getBoundingClientRect();
    return hitPlane(this.inverseVp, ((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2, PAGE_Z);
  }

  locate(clientX: number, clientY: number): PagePoint | null {
    const rect = this.surface.getBoundingClientRect();
    const hit = hitPlane(this.inverseVp, ((clientX - rect.left) / rect.width) * 2 - 1, 1 - ((clientY - rect.top) / rect.height) * 2, PAGE_Z);
    if (!hit) return null;
    const u = Math.abs(hit.x) / PAGE_W;
    const v = 0.5 - hit.y;
    return u <= 1.08 && v >= -0.03 && v <= 1.03 ? { side: hit.x < 0 ? 'left' : 'right', u, v } : null;
  }

  render(scene: Scene): void {
    this.scene = scene;
    if (this.lost) return;
    this.afterLanding();
    this.draw(scene);
    this.watchView(scene);
    this.updateGeometry(scene);
  }

  /** True while a page's text, photograph, or sharp copy is still fading in. */
  get animating(): boolean {
    for (const page of this.pages.values()) if ((page.uploaded && page.fade < 1) || (page.photo && page.photoFade < 1)) return true;
    for (const detail of this.details.values()) if (detail.shown && detail.on < 1) return true;
    return false;
  }

  /** Plans the sharp copies once the view has been still for a moment. */
  private watchView(scene: Scene): void {
    const key = `${this.vp.join()}|${scene.left}|${scene.right}|${scene.mode}|${this.moving}`;
    if (key !== this.viewKey) {
      this.viewKey = key;
      clearTimeout(this.detailTimer);
      this.detailTimer = window.setTimeout(() => {
        this.wantDetails = true;
        this.onChange();
      }, DETAIL_WAIT);
    }
    if (!this.wantDetails || this.moving) return;
    this.wantDetails = false;
    const wanted = new Set<string>();
    // A photograph has no more detail to give, so photo mode has no copies.
    if (scene.mode !== 'photo') {
      for (const [name, side] of [
        ['left', scene.left],
        ['right', scene.right],
      ] as const) {
        const page = side ? this.pages.get(side) : undefined;
        if (!side || !page?.uploaded) continue;
        const plan = this.planDetail(name);
        if (!plan) continue;
        wanted.add(side);
        this.applyDetail(side, page, plan);
      }
    }
    for (const side of [...this.details.keys()]) if (!wanted.has(side)) this.dropDetail(side);
    this.onChange();
  }

  /** The part of a page on the screen, with a margin, and the zoom that draws it one to one. */
  private planDetail(name: 'left' | 'right'): DetailPlan | null {
    const toCanvas = pageHomography(this.vp, name, PAGE_Z, this.pageSize, this.cssSize);
    const toPage = invert(toCanvas);
    const { width: pw, height: ph } = this.pageSize;
    const { width: cw, height: ch } = this.cssSize;
    const corners = [
      [0, 0],
      [cw, 0],
      [0, ch],
      [cw, ch],
    ];
    // A corner of the screen beyond the horizon has no place on the page. Its weight has the other sign.
    const weights = corners.map(([x, y]) => toPage[3] * x + toPage[7] * y + toPage[15]);
    if (weights.some((w) => w * weights[0] <= 0)) return null;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const [x, y] of corners) {
      const [px, py] = project(toPage, [x, y, 0]);
      xs.push(px);
      ys.push(py);
    }
    const core: [number, number, number, number] = [
      clamp(Math.min(...xs), 0, pw),
      clamp(Math.min(...ys), 0, ph),
      clamp(Math.max(...xs), 0, pw),
      clamp(Math.max(...ys), 0, ph),
    ];
    if (core[2] - core[0] < 1 || core[3] - core[1] < 1) return null;
    const cx = (core[0] + core[2]) / 2;
    const cy = (core[1] + core[3]) / 2;
    const at = (x: number, y: number) => project(toCanvas, [x, y, 0]);
    const middle = at(cx, cy);
    const across = at(cx + 1, cy);
    const down = at(cx, cy + 1);
    const magnified = Math.max(Math.hypot(across[0] - middle[0], across[1] - middle[1]), Math.hypot(down[0] - middle[0], down[1] - middle[1]));
    if (magnified < DETAIL_FROM) return null;
    const mx = (core[2] - core[0]) * DETAIL_MARGIN;
    const my = (core[3] - core[1]) * DETAIL_MARGIN;
    const x0 = Math.max(0, core[0] - mx);
    const y0 = Math.max(0, core[1] - my);
    const x1 = Math.min(pw, core[2] + mx);
    const y1 = Math.min(ph, core[3] + my);
    const ratio = this.surface.width / cw;
    let scale = Math.min(magnified, DETAIL_MOST_SCALE, this.maxTexture / ((x1 - x0) * ratio), this.maxTexture / ((y1 - y0) * ratio));
    // At most three screens of pixels, so a tilted view far across a page stays within memory.
    const budget = cw * ch * ratio * ratio * 3;
    const area = (x1 - x0) * (y1 - y0) * scale * scale * ratio * ratio;
    if (area > budget) scale *= Math.sqrt(budget / area);
    if (scale < DETAIL_FROM) return null;
    return { x0, y0, x1, y1, core, scale };
  }

  private applyDetail(side: string, page: GlPage, plan: DetailPlan): void {
    let detail = this.details.get(side);
    if (detail && detail.source !== page.element) {
      this.dropDetail(side);
      detail = undefined;
    }
    detail ??= this.makeDetail(side, page.element);
    const old = detail.plan;
    // The copy already holds this view at about this sharpness.
    if (
      old &&
      plan.core[0] >= old.x0 &&
      plan.core[1] >= old.y0 &&
      plan.core[2] <= old.x1 &&
      plan.core[3] <= old.y1 &&
      Math.abs(plan.scale / old.scale - 1) < 0.12
    ) {
      return;
    }
    detail.plan = plan;
    const s = plan.scale;
    detail.box.style.width = `${((plan.x1 - plan.x0) * s).toFixed(2)}px`;
    detail.box.style.height = `${((plan.y1 - plan.y0) * s).toFixed(2)}px`;
    detail.shift.style.left = `${(-plan.x0 * s).toFixed(2)}px`;
    detail.shift.style.top = `${(-plan.y0 * s).toFixed(2)}px`;
    detail.copy.style.zoom = String(s);
    detail.stale = true;
    this.surface.requestPaint();
  }

  private makeDetail(side: string, source: HTMLElement): GlDetail {
    const box = document.createElement('div');
    box.className = 'codex-detail';
    box.setAttribute('drawable', '');
    box.inert = true;
    box.setAttribute('aria-hidden', 'true');
    const shift = document.createElement('div');
    shift.className = 'codex-detail-shift';
    const copy = source.cloneNode(true) as HTMLElement;
    copy.removeAttribute('inert');
    copy.removeAttribute('aria-hidden');
    copy.removeAttribute('data-side');
    // A drawable element inside another is drawn on its own, and would leave the box empty.
    copy.removeAttribute('drawable');
    copy.dataset.detailOf = side;
    shift.append(copy);
    box.append(shift);
    this.surface.append(box);
    const texture = this.newTexture();
    // Drawn one to one with the screen, so it needs no smaller copies.
    this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    const detail: GlDetail = { source, box, shift, copy, texture, size: [0, 0], plan: null, shown: null, stale: true, on: 0, geometry: null };
    this.details.set(side, detail);
    this.detailByBox.set(box, detail);
    return detail;
  }

  private dropDetail(side: string): void {
    const detail = this.details.get(side);
    if (!detail) return;
    if (!detail.box.inert) mirrorSelection(detail.copy, detail.source);
    this.gl.deleteTexture(detail.texture);
    detail.box.remove();
    this.details.delete(side);
    this.detailByBox.delete(detail.box);
  }

  private uploadDetail(detail: GlDetail): boolean {
    const { gl } = this;
    const plan = detail.plan;
    if (!plan) return false;
    try {
      const size = this.surface.getElementImageDefaultSize(detail.box);
      const width = Math.ceil(size.width);
      const height = Math.ceil(size.height);
      if (!width || !height) return false;
      gl.bindTexture(gl.TEXTURE_2D, detail.texture);
      if (detail.size[0] !== width || detail.size[1] !== height) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        detail.size = [width, height];
      }
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      this.texturing.texElementSubImage2D(gl.TEXTURE_2D, 0, 0, 0, detail.box);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      const { width: pw, height: ph } = this.pageSize;
      detail.shown = [plan.x0 / pw, plan.y0 / ph, plan.x1 / pw, plan.y1 / ph];
      detail.stale = false;
      detail.geometry = null;
      return true;
    } catch {
      return false;
    }
  }

  private draw(scene: Scene): void {
    const { gl } = this;
    const canvas = this.surface;
    // Closer in, the view centers on what the reader chose, not on the whole book.
    const shiftY = this.fitShift * Math.min(1, this.fitDist / scene.pose.dist);
    this.vp = viewProjection(scene.pose, this.cssSize.width / this.cssSize.height, shiftY);
    this.inverseVp = invert(this.vp);
    const depths = stackDepths(scene.progress);
    const vp = new Float32Array(this.vp);
    gl.viewport(0, 0, canvas.width, canvas.height);
    const { theme } = this;
    gl.clearColor(theme.desk[0], theme.desk[1], theme.desk[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const rgb = (color: Theme['leaf']) => color.slice(0, 3);

    gl.useProgram(this.solidProgram);
    let u = this.solidU;
    gl.uniformMatrix4fv(u.uVP, false, vp);
    gl.uniform3f(u.uShadowBox, PAGE_W + 0.06, PAGE_H / 2 + 0.03, 0.05 + BLOCK * 0.6);
    gl.uniform3fv(u.uBoard, rgb(theme.board));
    gl.uniform3fv(u.uEdge, rgb(theme.edge));
    gl.uniform3fv(u.uDesk, rgb(theme.desk));
    gl.uniform4fv(u.uShade, theme.shade);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tile);
    const solid = (mesh: Mesh, kind: number) => {
      gl.uniform1i(u.uKind, kind);
      gl.bindVertexArray(mesh.vao);
      gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
    };
    const moving = (mesh: Mesh, verts: Float32Array, kind: number) => {
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer ?? null);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, verts);
      solid(mesh, kind);
    };
    solid(this.desk, 2);
    moving(this.cradle, cradleVertices(depths), 3);
    moving(this.boards, boardVertices(depths), 0);
    moving(this.block, blockVertices(depths), 1);

    gl.useProgram(this.pageProgram);
    u = this.pageU;
    gl.uniformMatrix4fv(u.uVP, false, vp);
    gl.uniform3fv(u.uLeafColor, rgb(theme.leaf));
    gl.uniform3fv(u.uLeafEdge, rgb(theme.edge));
    gl.uniform3fv(u.uInkColor, rgb(theme.ink));
    gl.uniform3fv(u.uZone, rgb(theme.zone));
    gl.uniform4fv(u.uShade, theme.pageShade);
    gl.uniform1i(u.uTile, 0);
    gl.uniform1i(u.uInkFront, 1);
    gl.uniform1i(u.uInkBack, 2);
    gl.uniform1i(u.uPhotoFront, 3);
    gl.uniform1i(u.uPhotoBack, 4);
    gl.uniform1f(u.uPhotoAll, scene.mode === 'photo' ? 1 : 0);
    gl.uniform3f(u.uLens, scene.lens?.x ?? 0, scene.lens?.y ?? 0, scene.mode === 'lens' && scene.lens ? 0.17 : 0);
    gl.bindVertexArray(this.pageMesh.vao);

    const shadow = leafShadow(scene.leaves.map((leaf) => leaf.t));
    gl.uniform3f(u.uShadow, shadow.x * PAGE_W, shadow.height * PAGE_W, shadow.strength);

    const drawPage = (front: string | null, back: string | null, seed: number) => {
      this.bindFace(front, 1, 3, u.uInkFrontOn, u.uPhotoFrontOn);
      this.bindFace(back, 2, 4, u.uInkBackOn, u.uPhotoBackOn);
      gl.uniform1f(u.uSeed, seed);
      gl.drawElements(gl.TRIANGLES, this.pageMesh.count, gl.UNSIGNED_SHORT, 0);
    };

    gl.uniform1i(u.uDetail, 5);
    const bindDetail = (side: string | null) => {
      const detail = side ? this.details.get(side) : undefined;
      const shown = detail?.shown ?? null;
      gl.activeTexture(gl.TEXTURE5);
      gl.bindTexture(gl.TEXTURE_2D, shown && detail ? detail.texture : this.tile);
      gl.activeTexture(gl.TEXTURE0);
      gl.uniform4fv(u.uDetailRect, shown ?? [0, 0, 1, 1]);
      gl.uniform1f(u.uDetailOn, shown && detail ? detail.on : 0);
    };

    gl.uniform1i(u.uIsLeaf, 0);
    gl.uniform1f(u.uFaux, 0);
    gl.uniform1f(u.uSide, -1);
    bindDetail(scene.left);
    drawPage(scene.left, null, seedOf(scene.left));
    gl.uniform1f(u.uSide, 1);
    bindDetail(scene.right);
    drawPage(scene.right, null, seedOf(scene.right));

    bindDetail(null);
    gl.uniform1i(u.uIsLeaf, 1);
    gl.uniform3f(u.uShadow, 0, 0, 0);
    scene.leaves.forEach((leaf, i) => {
      gl.uniform1f(u.uT, leaf.t);
      gl.uniform1f(u.uGrip, leaf.grip);
      gl.uniform1f(u.uFaux, leaf.front || leaf.back ? 0 : 1);
      drawPage(leaf.front, leaf.back, seedOf(leaf.front ?? leaf.back) + i * 0.37);
    });
    gl.bindVertexArray(null);
    for (const page of this.pages.values()) {
      if (page.uploaded && page.fade < 1) page.fade = Math.min(1, page.fade + scene.dt * 5.4);
      if (page.photo && page.photoFade < 1) page.photoFade = Math.min(1, page.photoFade + scene.dt * 3.6);
    }
    for (const detail of this.details.values()) {
      if (detail.shown && detail.on < 1) detail.on = Math.min(1, detail.on + scene.dt * 6);
    }
  }

  private bindFace(side: string | null, inkUnit: number, photoUnit: number, inkOn: WebGLUniformLocation | null, photoOn: WebGLUniformLocation | null): void {
    const { gl } = this;
    const page = side ? this.pages.get(side) : undefined;
    gl.activeTexture(gl.TEXTURE0 + inkUnit);
    gl.bindTexture(gl.TEXTURE_2D, page?.uploaded ? page.texture : this.tile);
    gl.uniform1f(inkOn, page?.uploaded ? page.fade : 0);
    gl.activeTexture(gl.TEXTURE0 + photoUnit);
    gl.bindTexture(gl.TEXTURE_2D, page?.photo ?? this.tile);
    gl.uniform1f(photoOn, page?.photo ? page.photoFade : 0);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * Only pages at rest take the pointer. Their elements lie exactly over their pixels.
   * Where a sharp copy shows, the copy takes the pointer and the selection instead.
   */
  private updateGeometry(scene: Scene): void {
    const resting = scene.leaves.length === 0;
    const sideName = (side: string) => (side === scene.left ? 'left' : 'right');
    for (const [side, detail] of this.details) {
      const live = resting && Boolean(detail.shown) && (side === scene.left || side === scene.right);
      if (detail.box.inert === live) {
        if (live) mirrorSelection(detail.source, detail.copy);
        else mirrorSelection(detail.copy, detail.source);
        detail.box.inert = !live;
        detail.box.setAttribute('aria-hidden', live ? 'false' : 'true');
      }
      if (!live || !detail.plan) {
        if (detail.geometry !== null) {
          this.surface.clearElementGeometry(detail.box);
          detail.geometry = null;
        }
        continue;
      }
      const { x0, y0, scale } = detail.plan;
      const fromBox = Float64Array.of(1 / scale, 0, 0, 0, 0, 1 / scale, 0, 0, 0, 0, 1, 0, x0, y0, 0, 1);
      const matrix = multiply(pageHomography(this.vp, sideName(side), PAGE_Z, this.pageSize, this.cssSize), fromBox);
      const key = matrix.join();
      if (key !== detail.geometry) {
        this.surface.updateElementGeometry(detail.box, { canvasTransform: DOMMatrix.fromFloat64Array(matrix) });
        detail.geometry = key;
      }
    }
    for (const [side, page] of this.pages) {
      const covered = this.details.get(side)?.box.inert === false;
      const placed = resting && (side === scene.left || side === scene.right) && !covered;
      // This restyles the whole page and repaints it, so it waits for the landing. Until then no page has geometry to hit.
      if (resting && page.element.inert === placed) {
        page.element.inert = !placed;
        page.element.setAttribute('aria-hidden', placed ? 'false' : 'true');
      }
      if (!placed) {
        if (page.geometry !== null) {
          this.surface.clearElementGeometry(page.element);
          page.geometry = null;
        }
        continue;
      }
      const matrix = pageHomography(this.vp, sideName(side), PAGE_Z, this.pageSize, this.cssSize);
      const key = matrix.join();
      if (key !== page.geometry) {
        this.surface.updateElementGeometry(page.element, { canvasTransform: DOMMatrix.fromFloat64Array(matrix) });
        page.geometry = key;
      }
    }
  }
}

const seedOf = (side: string | null): number => (side ? parseInt(side, 10) + (side.endsWith('B') ? 0 : -1) : 0.5);

function pushQuad(out: number[], a: number[], b: number[], c: number[], d: number[], n: number[]): void {
  for (const p of [a, b, c, a, c, d]) out.push(p[0], p[1], p[2], n[0], n[1], n[2]);
}

function quad(x0: number, x1: number, y0: number, y1: number, z: number, n: number[]): Float32Array {
  const out: number[] = [];
  pushQuad(out, [x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], n);
  return new Float32Array(out);
}

function cuboid(out: number[], x0: number, x1: number, y0: number, y1: number, z0: number, z1: number): void {
  pushQuad(out, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]);
  pushQuad(out, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0]);
  pushQuad(out, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0]);
  pushQuad(out, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0]);
  pushQuad(out, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0]);
}

type Depths = { left: number; right: number };

/** Each board lies under its stack, so it rises as the stack gets thinner. It stays a little larger than the leaves. */
function boardVertices(depths: Depths): Float32Array {
  const out: number[] = [];
  const half = PAGE_H / 2 + 0.024;
  const reach = (depth: number) => foreEdgeReach(depth) + 0.018;
  cuboid(out, -reach(depths.left), 0, -half, half, PAGE_Z - depths.left - BOARD, PAGE_Z - depths.left);
  cuboid(out, 0, reach(depths.right), -half, half, PAGE_Z - depths.right - BOARD, PAGE_Z - depths.right);
  return new Float32Array(out);
}

/** The two sides of the cradle, which fill the room under the boards and keep the open pages level. */
function cradleVertices(depths: Depths): Float32Array {
  const out: number[] = [];
  const half = PAGE_H / 2 + 0.024;
  const reach = (depth: number) => foreEdgeReach(depth) + 0.018;
  cuboid(out, -reach(depths.left), 0, -half, half, 0, PAGE_Z - depths.left - BOARD);
  cuboid(out, 0, reach(depths.right), -half, half, 0, PAGE_Z - depths.right - BOARD);
  return new Float32Array(out);
}

/** The stacks of leaves under the open pages. The fore-edge slants out, so an overhead view still shows the paper. */
function blockVertices(depths: Depths): Float32Array {
  const out: number[] = [];
  for (const [sign, depth] of [
    [-1, depths.left],
    [1, depths.right],
  ] as const) {
    const bottom = PAGE_Z - depth;
    const top = sign * PAGE_W;
    const low = sign * foreEdgeReach(depth);
    const slope = Math.hypot(depth, low - top) || 1;
    pushQuad(out, [low, -0.5, bottom], [low, 0.5, bottom], [top, 0.5, PAGE_Z], [top, -0.5, PAGE_Z], [(sign * depth) / slope, 0, Math.abs(low - top) / slope]);
    for (const [y, n] of [
      [-0.5, -1],
      [0.5, 1],
    ] as const) {
      pushQuad(out, [0, y, bottom], [low, y, bottom], [top, y, PAGE_Z], [0, y, PAGE_Z], [0, n, 0]);
    }
  }
  return new Float32Array(out);
}

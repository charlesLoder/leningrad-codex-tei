/**
 * The plain book, for a browser without HTML-in-Canvas. The pages are ordinary
 * elements that turn with CSS 3D transforms, as rigid leaves. Selection and copying
 * work the same way, because the text is the same DOM.
 */
import { PAGE_H, PAGE_W } from './math.ts';
import { type BookView, type PagePoint, pageElementSize, type Scene } from './view.ts';

const PERSPECTIVE = 2600;

export class CssView implements BookView {
  readonly surface: HTMLElement;
  readonly canOrbit = false;
  readonly animating = false;
  readonly pageSize = pageElementSize(1.5);
  onChange: () => void = () => {};
  private readonly book: HTMLElement;
  private readonly pages = new Map<string, HTMLElement>();
  private readonly blanks: HTMLElement[] = [];
  private origin = { x: 0, y: 0 };
  private worldPx = 1;
  private baseScale = 1;

  constructor(host: HTMLElement) {
    const surface = document.createElement('div');
    surface.className = 'codex-css-stage';
    surface.setAttribute('role', 'group');
    surface.setAttribute('aria-label', 'Open book');
    surface.style.perspective = `${PERSPECTIVE}px`;
    const book = document.createElement('div');
    book.className = 'codex-css-book';
    surface.append(book);
    host.append(surface);
    this.surface = surface;
    this.book = book;
  }

  addPage(side: string, element: HTMLElement): void {
    this.book.append(element);
    this.pages.set(side, element);
  }

  removePage(side: string): void {
    this.pages.get(side)?.remove();
    this.pages.delete(side);
  }

  setPhoto(side: string, image: HTMLImageElement): void {
    const page = this.pages.get(side);
    if (!page) return;
    page.querySelector('.codex-photo')?.remove();
    image.className = 'codex-photo';
    image.alt = '';
    page.prepend(image);
  }

  /** The pages use the theme's CSS variables directly. */
  refreshTheme(): void {}

  fit(pageOnly: boolean, insetBottom: number): number {
    const { clientWidth: width, clientHeight: height } = this.surface;
    const room = Math.max(120, height - insetBottom);
    const spread = (pageOnly ? 1 : 2) * this.pageSize.width * 1.04;
    this.baseScale = Math.min(width / spread, room / (this.pageSize.height * 1.05));
    return 1;
  }

  render(scene: Scene): void {
    const { clientWidth: width, clientHeight: height } = this.surface;
    const { width: pw, height: ph } = this.pageSize;
    const scale = this.baseScale / scene.pose.dist;
    this.worldPx = (ph / PAGE_H) * scale;
    this.origin = { x: width / 2, y: (height - scene.insetBottom) / 2 };
    this.surface.style.perspectiveOrigin = `${this.origin.x}px ${this.origin.y}px`;
    this.surface.dataset.mode = scene.mode;
    const x = this.origin.x - scene.pose.x * this.worldPx;
    const y = this.origin.y + scene.pose.y * this.worldPx;
    this.book.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${scale})`;

    const shown = new Set<string>();
    const place = (element: HTMLElement, transform: string, origin: string, z: number) => {
      element.style.visibility = 'visible';
      element.style.transform = transform;
      element.style.transformOrigin = origin;
      element.style.zIndex = String(z);
    };
    const leftSlot = `translate3d(${-pw}px, ${-ph / 2}px, 0)`;
    const rightSlot = `translate3d(0, ${-ph / 2}px, 0)`;
    const pageOf = (side: string | null) => (side ? this.pages.get(side) : undefined);

    const leftPage = pageOf(scene.left);
    if (leftPage && scene.left) {
      place(leftPage, leftSlot, '100% 50%', 1);
      shown.add(scene.left);
    }
    const rightPage = pageOf(scene.right);
    if (rightPage && scene.right) {
      place(rightPage, rightSlot, '0 50%', 1);
      shown.add(scene.right);
    }

    let blank = 0;
    const blankFace = () => {
      if (!this.blanks[blank]) {
        const face = document.createElement('div');
        face.className = 'codex-page codex-page-solid codex-blank';
        face.style.width = `${pw}px`;
        face.style.height = `${ph}px`;
        this.book.append(face);
        this.blanks[blank] = face;
      }
      return this.blanks[blank++];
    };
    scene.leaves.forEach((leaf, i) => {
      const lift = i + 2;
      const front = pageOf(leaf.front) ?? blankFace();
      const back = pageOf(leaf.back) ?? blankFace();
      place(front, `${leftSlot} translateZ(${lift}px) rotateY(${leaf.t * 180}deg)`, '100% 50%', lift);
      place(back, `${rightSlot} translateZ(${lift}px) rotateY(${(leaf.t - 1) * 180}deg)`, '0 50%', lift);
      if (leaf.front) shown.add(leaf.front);
      if (leaf.back) shown.add(leaf.back);
    });
    this.blanks.slice(blank).forEach((face) => {
      face.style.visibility = 'hidden';
    });

    for (const [side, element] of this.pages) {
      const placed = shown.has(side);
      if (!placed) element.style.visibility = 'hidden';
      if (element.inert === placed) {
        element.inert = !placed;
        element.setAttribute('aria-hidden', placed ? 'false' : 'true');
      }
      if (scene.mode === 'lens' && scene.lens && placed) {
        const isLeft = side === scene.left;
        const px = ((scene.lens.x + (isLeft ? PAGE_W : 0)) / PAGE_W) * pw;
        const py = (0.5 - scene.lens.y) * ph;
        element.style.setProperty('--lens-x', `${px}px`);
        element.style.setProperty('--lens-y', `${py}px`);
        element.style.setProperty('--lens-r', `${0.17 * ph}px`);
      } else {
        element.style.setProperty('--lens-r', '0px');
      }
    }
  }

  worldAt(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.surface.getBoundingClientRect();
    if (!this.worldPx) return null;
    const book = new DOMMatrix(getComputedStyle(this.book).transform);
    return { x: (clientX - rect.left - book.e) / this.worldPx, y: -(clientY - rect.top - book.f) / this.worldPx };
  }

  locate(clientX: number, clientY: number): PagePoint | null {
    const hit = this.worldAt(clientX, clientY);
    if (!hit) return null;
    const u = Math.abs(hit.x) / PAGE_W;
    const v = 0.5 - hit.y;
    if (u > 1.08 || v < -0.03 || v > 1.03) return null;
    return { side: hit.x < 0 ? 'left' : 'right', u, v };
  }
}

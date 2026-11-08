/** What the book's controller asks of a renderer. The WebGL and CSS views both do this. */
import { PAGE_H, PAGE_W, type Pose } from './math.ts';

export type ViewMode = 'text' | 'lens' | 'photo';

/** A leaf in the air. `t` is 0 flat on the left and 1 flat on the right. */
export interface SceneLeaf {
  /** The side on top when the leaf lies on the left (a recto), or null for a blank leaf. */
  front: string | null;
  /** The side on top when the leaf lies on the right (a verso). */
  back: string | null;
  t: number;
  /** Which part of the free edge the hand holds: 1 at the head, -1 at the tail, already signed for the direction of the turn. */
  grip: number;
}

export interface Scene {
  left: string | null;
  right: string | null;
  leaves: SceneLeaf[];
  /** 0 at the first opening and 1 at the last. */
  progress: number;
  pose: Pose;
  mode: ViewMode;
  /** Where the lens is, in world units on the page, or null while the pointer is away. */
  lens: { x: number; y: number } | null;
  /** Room at the bottom of the stage for the controls, in CSS pixels. */
  insetBottom: number;
  /** Seconds of motion since the last frame. Slow motion makes it shorter than the real time. */
  dt: number;
}

export interface PagePoint {
  side: 'left' | 'right';
  /** 0 at the spine and 1 at the fore-edge. */
  u: number;
  /** 0 at the head and 1 at the tail. */
  v: number;
}

export interface BookView {
  /** Receives the pointer events and holds the page elements. */
  readonly surface: HTMLElement;
  readonly pageSize: { width: number; height: number };
  /** The renderer can tilt and orbit the book. */
  readonly canOrbit: boolean;
  /** A picture still fades in, so another frame is needed. */
  readonly animating: boolean;
  /** The view has something new to show. */
  onChange: () => void;
  addPage(side: string, element: HTMLElement): void;
  removePage(side: string): void;
  /** The photograph of a side is ready to show. */
  setPhoto(side: string, image: HTMLImageElement): void;
  /** The site's theme changed. */
  refreshTheme(): void;
  /** Called once per frame while something moves. */
  render(scene: Scene): void;
  /** The resting page under a screen point, also a little past the fore-edge. */
  locate(clientX: number, clientY: number): PagePoint | null;
  /** The point on the plane of the book under a screen point, in world units. */
  worldAt(clientX: number, clientY: number): { x: number; y: number } | null;
  /** The distance and vertical shift that show the book, for the size of the stage. */
  fit(pageOnly: boolean, insetBottom: number): number;
}

/** Keep each page in this many grid pixels, so the texture stays sharp but not heavy. */
export function pageElementSize(devicePixelRatio: number): { width: number; height: number } {
  const width = devicePixelRatio >= 1.5 ? 860 : 1120;
  return { width, height: Math.round((width * PAGE_H) / PAGE_W) };
}

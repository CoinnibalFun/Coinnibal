import { VIEW, clamp, viewSize } from '@coinnibal/shared';
import { zoomIn } from '../design/curves';

export class Camera {
  x = 2800;
  y = 2800;
  zoom = 0.6;
  /** User zoom (mouse wheel), limited so we never show past the server's margin. */
  userZoom = 1;
  w = 1;
  h = 1;
  private initialized = false;
  /** Zoom without the transition multipliers (the follow target). */
  private base = 0.6;
  /** Entering a room: the camera falls from far to normal (`zoomIn` curve), seconds elapsed / length. */
  private intro: { t: number; dur: number; from: number } | null = null;
  /** Death slow motion: a slight push in (multiplier, eased back by the engine). */
  push = 1;
  /** The world's playable rectangle: the camera centre never leaves it (null: unclamped). */
  limit: { x0: number; y0: number; x1: number; y1: number } | null = null;

  /** Starts the fall into the world (lobby → game). `dur` in seconds; 0 cancels. */
  zoomIntro(dur: number, from = 0.42): void {
    this.intro = dur > 0 ? { t: 0, dur, from } : null;
  }

  /** True while the entering zoom runs. */
  get introducing(): boolean {
    return this.intro !== null;
  }

  resize(w: number, h: number): void {
    this.w = w;
    this.h = h;
  }

  /** Smoothly follows a target; `snap` jumps immediately (first frame / respawn). */
  follow(tx: number, ty: number, visibleShort: number, dt: number, snap = false): void {
    const shortPx = Math.min(this.w, this.h);
    const targetZoom = (shortPx / visibleShort) * this.userZoom;
    if (snap || !this.initialized) {
      this.x = tx;
      this.y = ty;
      this.base = targetZoom;
      this.initialized = true;
    } else {
      const k = 1 - Math.exp(-dt * 9);
      this.x += (tx - this.x) * k;
      this.y += (ty - this.y) * k;
      const kz = 1 - Math.exp(-dt * 4.5);
      this.base += (targetZoom - this.base) * kz;
    }
    const L = this.limit;
    if (L && L.x1 > L.x0 && L.y1 > L.y0) {
      this.x = clamp(this.x, L.x0, L.x1);
      this.y = clamp(this.y, L.y0, L.y1);
    }
    let mul = this.push;
    if (this.intro) {
      this.intro.t += dt;
      const p = this.intro.t / this.intro.dur;
      mul *= zoomIn(p, this.intro.from);
      if (p >= 1) this.intro = null;
    }
    this.zoom = this.base * mul;
  }

  /** Visible short side (world units) for a mass, honouring the screen aspect. */
  visibleShortFor(mass: number, spectator = false): number {
    const v = viewSize(mass, this.w / Math.max(1, this.h), spectator);
    return Math.min(v.w, v.h);
  }

  /**
   * Visible short side (world units) for the view the server sends (its `h`, the view's height, see `viewSize`) on
   * this screen: a paid room's spectator gets exactly the followed coin's own view (anti-ghosting), so the camera
   * shows that and no more (past it the paper would be empty).
   */
  visibleShortForServer(serverH: number): number {
    return shortForServerView(serverH, this.w / Math.max(1, this.h));
  }

  wheel(deltaY: number): void {
    const f = Math.exp(-deltaY * 0.0012);
    this.userZoom = clamp(this.userZoom * f, 1 / (VIEW.serverMargin - 0.04), 1.6);
  }

  toWorld(sx: number, sy: number, out: { x: number; y: number } = { x: 0, y: 0 }): { x: number; y: number } {
    out.x = this.x + (sx - this.w / 2) / this.zoom;
    out.y = this.y + (sy - this.h / 2) / this.zoom;
    return out;
  }

  toScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.w / 2, y: (wy - this.y) * this.zoom + this.h / 2 };
  }

  /** World rectangle currently on screen (plus padding in world units). */
  visibleRect(pad = 0): { x0: number; y0: number; x1: number; y1: number } {
    return this.visibleRectInto({ x0: 0, y0: 0, x1: 0, y1: 0 }, pad);
  }

  /** `visibleRect` into `out` (the render loop's scratch: no garbage per frame). */
  visibleRectInto<T extends { x0: number; y0: number; x1: number; y1: number }>(out: T, pad = 0): T {
    const hw = this.w / 2 / this.zoom + pad;
    const hh = this.h / 2 / this.zoom + pad;
    out.x0 = this.x - hw;
    out.y0 = this.y - hh;
    out.x1 = this.x + hw;
    out.y1 = this.y + hh;
    return out;
  }
}

/**
 * The short side of a server view of height `h` on a screen of `aspect` (width / height): a wide screen's height is
 * its short side; a tall screen's short side is its width, `h × aspect` (`viewSize`, the server clamps the aspect to
 * `VIEW.minAspect`, so a taller screen shows a little less, never past what was sent).
 */
export function shortForServerView(h: number, aspect: number): number {
  if (!(h > 0)) return VIEW.base;
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  return a >= 1 ? h : h * a;
}

/**
 * The camera's visible short side while there is no own coin to follow (the lobby's live view, watching, the death
 * screen). A paid room (`paid`: an arena instance or a paid custom room) gets exactly the server's view (`serverH`,
 * the followed coin's own view: anti-ghosting); a free room shows the room wide like a spectator (`wide`: the lobby
 * and the watch screen; a little inside the server's wide view) or, after a death, a mid-size coin's view.
 */
export function watchShort(camera: Pick<Camera, 'visibleShortFor' | 'visibleShortForServer'>, o: { paid: boolean; wide: boolean; serverH: number | null }): number {
  if (o.paid && o.serverH !== null) return camera.visibleShortForServer(o.serverH);
  return o.wide ? camera.visibleShortFor(0, true) * 0.85 : camera.visibleShortFor(400);
}

/**
 * The pill ⇄ menu morph (title-pill.ts on desktop, phone-menu.ts on phones): a clip-path from the
 * pill's rect and radius to the menu's own, with the menu's rows fading in after (or out before).
 *
 * Why not element.animate({ clipPath })? Chrome runs clip-path animations on the compositor, and
 * the hand-offs flicker (seen in kayg's 120fps capture, 2026-11-15):
 *   - start: until the compositor's clip mask is ready the menu paints UNCLIPPED for ~2 frames
 *     (the full-size glass with its rows still at opacity 0, an "empty panel"), or, when closing,
 *     not at all for ~6 frames;
 *   - end: cancel()ing the finished animations (to let go of the clip) blanks the layer for a frame.
 * So the clip and the rows' opacity are driven here, from one requestAnimationFrame loop, as inline
 * styles: the first frame is set synchronously (before the browser paints the menu), and the end
 * simply removes the inline styles. A menu is small: one clip and a few opacities per frame is far
 * inside the 8.3ms (120fps) budget.
 *
 * Easing is evaluated with a cubic-bezier solver so the curve matches CSS's exactly.
 */

/** Emil Kowalski's strong ease-out, cubic-bezier(0.23, 1, 0.32, 1). */
export const EASE_OUT_PTS = [0.23, 1, 0.32, 1] as const;

/** A CSS cubic-bezier(x1, y1, x2, y2) as a function of progress 0..1 (Newton, then bisection). */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (u: number) => ((ax * u + bx) * u + cx) * u;
  const y = (u: number) => ((ay * u + by) * u + cy) * u;
  const dx = (u: number) => (3 * ax * u + 2 * bx) * u + cx;
  return (t) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let u = t;
    for (let i = 0; i < 6; i++) {
      const err = x(u) - t, d = dx(u);
      if (Math.abs(err) < 1e-5) return y(u);
      if (Math.abs(d) < 1e-6) break;
      u -= err / d;
    }
    let lo = 0, hi = 1; u = t;
    for (let i = 0; i < 24; i++) { if (x(u) < t) lo = u; else hi = u; u = (lo + hi) / 2; }
    return y(u);
  };
}
const easeOut = bezier(...EASE_OUT_PTS);

export interface MorphTiming {
  /** The clip's duration. */
  ms: number;
  /** The rows' fade: delay and duration (opening: in after the clip starts; closing: out at once). */
  fadeDelay: number;
  fadeMs: number;
  /** The rows' fade curve: the ease-out when opening, linear when closing. */
  fadeEase: "out" | "linear";
}

/** Inset clip as numbers: top right bottom left, radius. */
type Inset = [number, number, number, number, number];
const css = (c: Inset) => `inset(${c[0].toFixed(2)}px ${c[1].toFixed(2)}px ${c[2].toFixed(2)}px ${c[3].toFixed(2)}px round ${c[4].toFixed(2)}px)`;

const running = new WeakMap<HTMLElement, () => void>();

/** Stops a running morph on `menu` and drops its inline clip and the rows' opacity. */
export function stopMorph(menu: HTMLElement) {
  running.get(menu)?.();
}

/**
 * Morphs `menu` from (opening) or into (closing) `pill`'s rect and corner radius.
 * Resolves when done. Opening ends with no inline clip (the menu's shadow and edge are never
 * clipped); closing ends held at the pill's rect, rows hidden (the caller removes the menu).
 */
export function clipMorph(menu: HTMLElement, pill: HTMLElement, opening: boolean, timing: MorphTiming): Promise<void> {
  stopMorph(menu);
  const kids = [...menu.children] as HTMLElement[];
  const m = menu.getBoundingClientRect();
  const p = pill.getBoundingClientRect();
  const pr = Math.min(parseFloat(getComputedStyle(pill).borderTopLeftRadius) || p.height / 2, p.height / 2, p.width / 2);
  const r1 = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 14;
  const small: Inset = [p.top - m.top, m.right - p.right, m.bottom - p.bottom, p.left - m.left, pr];
  const full: Inset = [0, 0, 0, 0, r1];
  const [from, to] = opening ? [small, full] : [full, small];
  const fadeEase = timing.fadeEase === "out" ? easeOut : (t: number) => t;

  let raf = 0;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const clear = () => {
    menu.style.removeProperty("clip-path");
    for (const k of kids) k.style.removeProperty("opacity");
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    running.delete(menu);
    clear();
    resolve();
  };
  running.set(menu, stop);

  const t0 = performance.now();
  const paint = (now: number) => {
    const t = Math.min(1, (now - t0) / timing.ms);
    const e = easeOut(t);
    menu.style.setProperty("clip-path", css(from.map((v, i) => v + (to[i] - v) * e) as Inset));
    const f = fadeEase(Math.max(0, Math.min(1, (now - t0 - timing.fadeDelay) / timing.fadeMs)));
    const o = (opening ? f : 1 - f).toFixed(3);
    for (const k of kids) k.style.setProperty("opacity", o);
    const fadeEnd = timing.fadeDelay + timing.fadeMs;
    if (now - t0 >= Math.max(timing.ms, fadeEnd)) {
      running.delete(menu);
      if (opening) clear(); // let go: no clip, rows at their own opacity
      resolve();
      return;
    }
    raf = requestAnimationFrame(paint);
  };
  // The first frame now, synchronously: the menu is never painted unclipped.
  paint(t0); // schedules the following frames itself
  return done;
}

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

/** Extras for the morph (all optional). */
export interface MorphOptions {
  /** Closing: called when the button should reappear (~160ms in, as iOS brings it back before the glass has
   *  fully shrunk into it). The caller shows its button and plays the swell-in (see buttonSwell). */
  onReturn?: () => void;
}

/** Inset clip as numbers: top right bottom left, radius. */
type Inset = [number, number, number, number, number];
const css = (c: Inset) => `inset(${c[0].toFixed(2)}px ${c[1].toFixed(2)}px ${c[2].toFixed(2)}px ${c[3].toFixed(2)}px round ${c[4].toFixed(2)}px)`;

const running = new WeakMap<HTMLElement, () => void>();

/** Stops a running morph on `menu` and drops its inline clip, scale and the rows' styles. */
export function stopMorph(menu: HTMLElement) {
  running.get(menu)?.();
}

/**
 * A damped spring's progress (0 → 1, overshooting a little), as iOS's own: `response` is the period in ms,
 * `damping` the ratio. Fitted from Files' and Reminders' ⋯ menus (iOS 27, 60fps, 2026-11-15): response
 * ≈330ms, damping ≈0.74 → a 2–4% overshoot peaking ~290ms, settled ~480ms.
 */
function spring(t: number, response = 330, damping = 0.74): number {
  if (t <= 0) return 0;
  const w = (2 * Math.PI) / response;
  const wd = w * Math.sqrt(1 - damping * damping);
  return 1 - Math.exp(-damping * w * t) * (Math.cos(wd * t) + ((damping * w) / wd) * Math.sin(wd * t));
}
const closeEase = bezier(0.2, 0, 0.5, 1);

/** The button coming back after a close, as iOS's: from about half size, unblurring, a slight swell. */
export function buttonSwell(el: HTMLElement, from = 0.5) {
  el.animate(
    { scale: [from, 1 + (1 - from) * 0.08, 1], filter: ["blur(3px)", "blur(0px)", "blur(0px)"], opacity: [0.4, 1, 1] },
    { duration: 260, easing: "cubic-bezier(0.23, 1, 0.32, 1)" },
  );
}

/**
 * The button ⇄ menu morph, after iOS 27's own (measured in Files and Reminders):
 *   - Open: the button's own shape grows into the menu on a spring, staying fully round (a capsule, radius
 *     = half its shorter side) until ~75% grown, then its corners tighten to the menu's radius; the top-
 *     trailing corner stays on the button's. The rows are drawn at their final size, clipped by the shape and
 *     blurred; they come into focus (blur 10px → 0, opacity 0 → 1) between ~75% and ~95% grown. A slight
 *     overshoot (the spring) shows as a scale about the button's corner.
 *   - Close: the rows blur and fade out first (~70ms, linear); the empty glass shrinks back into the
 *     button's rect as a capsule (~250ms, cubic-bezier(0.2, 0, 0.5, 1)); at ~160ms the caller brings the
 *     button back (onReturn → buttonSwell).
 * Driven from one rAF loop with inline styles (see the file header for why not WAAPI on clip-path); the
 * first frame is set synchronously. Opening ends with no inline styles; closing ends held at the button.
 */
export function clipMorph(menu: HTMLElement, pill: HTMLElement, opening: boolean, opts: MorphOptions = {}): Promise<void> {
  stopMorph(menu);
  const kids = [...menu.children] as HTMLElement[];
  const m = menu.getBoundingClientRect();
  const p = pill.getBoundingClientRect();
  const r1 = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 14;
  // The button's rect inside the menu's box (insets from each side).
  const small = [p.top - m.top, m.right - p.right, m.bottom - p.bottom, p.left - m.left];
  const origin = `${(p.right - m.left).toFixed(1)}px ${(p.top - m.top).toFixed(1)}px`; // the button's top-trailing corner
  const OPEN_SETTLE = 480, CLOSE_MS = 250, RETURN_AT = 160;

  let raf = 0;
  let resolve!: () => void;
  const done = new Promise<void>((r) => (resolve = r));
  const clear = () => {
    menu.style.removeProperty("clip-path");
    menu.style.removeProperty("scale");
    menu.style.removeProperty("transform-origin");
    for (const k of kids) { k.style.removeProperty("opacity"); k.style.removeProperty("filter"); }
  };
  const stop = () => {
    cancelAnimationFrame(raf);
    running.delete(menu);
    clear();
    resolve();
  };
  running.set(menu, stop);
  menu.style.setProperty("transform-origin", origin);

  /** The clip at growth `g` (0 = the button, 1 = the menu), with the radius rule above. */
  const clipAt = (g: number, round: boolean): string => {
    const k = Math.max(0, Math.min(1, g));
    const ins = small.map((v) => v * (1 - k)) as number[];
    const w = m.width - ins[1] - ins[3];
    const h = m.height - ins[0] - ins[2];
    const capsule = Math.min(w, h) / 2;
    const corner = round ? capsule : k < 0.75 ? capsule : capsule + (Math.min(r1, capsule) - capsule) * ((k - 0.75) / 0.25);
    return css([ins[0], ins[1], ins[2], ins[3], corner] as Inset);
  };
  const rows = (opacity: number, blur: number) => {
    const o = opacity.toFixed(3), f = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "none";
    for (const k of kids) { k.style.setProperty("opacity", o); k.style.setProperty("filter", f); }
  };

  const t0 = performance.now();
  let returned = false;
  const paint = (now: number) => {
    const t = now - t0;
    if (opening) {
      const g = spring(t);
      menu.style.setProperty("clip-path", clipAt(g, false));
      menu.style.setProperty("scale", g > 1 ? (1 + (g - 1) * 0.5).toFixed(4) : "1"); // the overshoot, about the button's corner
      const focus = Math.max(0, Math.min(1, (Math.min(g, 1) - 0.75) / 0.2));
      rows(focus, 10 * (1 - focus));
      if (t >= OPEN_SETTLE) { running.delete(menu); clear(); resolve(); return; }
    } else {
      const k = 1 - closeEase(Math.min(1, t / CLOSE_MS));
      menu.style.setProperty("clip-path", clipAt(k, t > 30));
      const fade = Math.min(1, t / 70);
      rows(1 - fade, 8 * fade);
      if (!returned && t >= RETURN_AT) { returned = true; opts.onReturn?.(); }
      if (t >= CLOSE_MS) { running.delete(menu); if (!returned) opts.onReturn?.(); resolve(); return; }
    }
    raf = requestAnimationFrame(paint);
  };
  paint(t0); // the first frame now, synchronously: the menu is never painted unclipped
  return done;
}

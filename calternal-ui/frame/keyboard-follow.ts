/**
 * The phone composer rides with the iOS keyboard instead of jumping after it (kayg: "keyboard opens and then
 * composer"; ChatGPT and Claude move theirs every frame).
 *
 * What iOS Safari gives a page (measured in the iOS 27 simulator, 2026-11-15): no per-frame keyboard
 * position at all. `visualViewport` resizes ONCE, already at its final size (+115ms home-screen app, +148ms
 * Safari tab), and iOS scrolls the page to reveal the field. bb answers that one event in its next animation
 * frame: it sets the app shell to the visible height and scrolls the page back. So the composer's position
 * on screen changes in a step, which read as "the keyboard, then the composer".
 *
 * This smooths every such step with a FLIP: on each visualViewport/window resize or scroll during a focus
 * change, the composer's position on screen is read right away (before bb's frame), and again in our own
 * frame (registered after bb's, so bb's layout is in); if it jumped, the composer is translated back to where
 * it was and glides to its new place on the keyboard's curve, before anything is painted. Only `translate`
 * on one element moves (composited). Keyboard actions keep the default (input-mode), and nothing runs
 * outside a ~900ms window around a focus change on the composer's text field.
 */
const COMPOSER = "[data-app-composer]";
const EDITOR = '[data-app-composer] [contenteditable="true"]';
const CURVE = "cubic-bezier(0.32, 0.72, 0, 1)"; // close to iOS's keyboard curve
const GLIDE_MS = 320;

export function mountKeyboardFollow(): () => void {
  const vv = window.visualViewport;
  if (!vv || navigator.maxTouchPoints === 0) return () => {};
  const phone = matchMedia("(max-width: 767px)");
  let activeUntil = 0;
  let glide: Animation | null = null;
  let glideStart = 0;

  const animates = () => document.documentElement.getAttribute("data-cf-input") !== "keys" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
  /** The composer's top on SCREEN (the layout box less the visual viewport's scroll), without our translate. */
  const screenTop = (el: HTMLElement) => {
    const shift = glide ? (parseFloat(getComputedStyle(el).translate.split(" ")[1] ?? "0") || 0) : 0;
    return el.getBoundingClientRect().top - shift - vv.offsetTop;
  };
  const visualTop = (el: HTMLElement) => el.getBoundingClientRect().top - vv.offsetTop;

  const onFocusChange = (e: FocusEvent) => {
    if (!phone.matches || !(e.target instanceof Element) || !e.target.closest?.(EDITOR)) return;
    activeUntil = performance.now() + 900;
    watchPane();
  };

  /** The composer's on-screen top as it was when the last viewport event arrived (before bb re-laid out). */
  let before: { el: HTMLElement; top: number; at: number } | null = null;
  const settle = () => {
    const b = before;
    if (!b || !b.el.isConnected) return;
    const after = screenTop(b.el);
    const delta = b.top - after;
    if (Math.abs(delta) < 2) return; // bb hasn't moved it (yet): keep waiting for its layout
    before = null;
    const now = performance.now();
    const left = glide ? Math.max(180, GLIDE_MS - (now - glideStart)) : GLIDE_MS;
    glide?.cancel();
    glideStart = now;
    glide = b.el.animate({ translate: [`0 ${delta.toFixed(1)}px`, "0 0"] }, { duration: left, easing: CURVE });
    const mine = glide;
    void mine.finished.then(() => { if (glide === mine) glide = null; }, () => {});
  };
  const onViewport = () => {
    if (performance.now() > activeUntil || !phone.matches || !animates()) return;
    const el = document.querySelector<HTMLElement>(COMPOSER);
    if (!el) return;
    if (!before) before = { el, top: visualTop(el), at: performance.now() };
    // bb lays out in its own animation frame. If our frame runs after bb's, the jump is visible there; if
    // before, the pane's ResizeObserver (after layout, before paint) catches it. Whichever sees it first.
    requestAnimationFrame(() => { settle(); if (before && performance.now() - before.at > 300) before = null; });
  };
  const paneSize = new ResizeObserver(() => { if (before) settle(); });
  let pane: Element | null = null;
  const watchPane = () => {
    const main = document.querySelector('main[data-sidebar="inset"]');
    if (main && main !== pane) { paneSize.disconnect(); paneSize.observe(main); pane = main; }
  };
  const paneTimer = window.setInterval(watchPane, 2000);
  watchPane();

  document.addEventListener("focusin", onFocusChange, true);
  document.addEventListener("focusout", onFocusChange, true);
  vv.addEventListener("resize", onViewport);
  vv.addEventListener("scroll", onViewport);
  window.addEventListener("resize", onViewport);
  window.addEventListener("scroll", onViewport, { passive: true });
  return () => {
    document.removeEventListener("focusin", onFocusChange, true);
    document.removeEventListener("focusout", onFocusChange, true);
    vv.removeEventListener("resize", onViewport);
    vv.removeEventListener("scroll", onViewport);
    window.removeEventListener("resize", onViewport);
    window.removeEventListener("scroll", onViewport);
    glide?.cancel();
    paneSize.disconnect();
    window.clearInterval(paneTimer);
  };
}

/**
 * The phone composer rides with the iOS keyboard, like ChatGPT's and Claude's: the messages and the composer move
 * up together as the keyboard rises and down as it falls, while the header stays put.
 *
 * What iOS 27 Safari gives a page (simulator, 2026-11-15/16; /tmp/composer-kb* hold the recordings):
 * - No per-frame keyboard position. `visualViewport` resizes once, already at its final size, ~110–130ms after
 *   the keyboard starts to move (a light test page sometimes got it a frame before).
 * - Focusing a field the keyboard will cover makes iOS scroll the page to reveal it: an animated scroll outside
 *   the page, decided at focus time. `focus({ preventScroll: true })` doesn't stop it, overflow: hidden doesn't,
 *   a `scrollTo(0, 0)` during it makes the page jump down and slide back, and rAF stalls while it runs. bb also
 *   shrinks its shell to the visible height in its next frame, so the two added up: the composer flew past the
 *   keyboard to the top, the page went blank, then bb scrolled back.
 * - Focusing a field that is already in view scrolls nothing, also while the keyboard is up.
 *
 * So the reveal scroll never starts, and the motion is ours:
 * 1. A tap on the composer doesn't focus its editor: its touchend is cancelled and an invisible editable stand-in
 *    at the top of the screen takes focus (from the tap, so iOS shows the keyboard). It is in view: no scroll.
 * 2. In the next frame the shell is held at its size (`data-cf-kb-hold`: !important over the inline top/height bb
 *    sets when the viewport resizes) and the scroller's parent translates up by the keyboard's height (remembered
 *    per display mode, corrected when the viewport reports it) on the keyboard's curve. Messages and the sticky
 *    composer move together; the header is outside and stays.
 * 3. Once the ride is over and the viewport has resized, everything is swapped in one task: hold off, translate
 *    off, scroller scrolled by the distance (nothing moves on screen; an error from memory glides out), and the
 *    editor takes focus with the caret where the tap was and anything typed into the stand-in carried over.
 * 4. Close: when the editor loses focus bb restores the full-height shell at once. Our window listener runs after
 *    bb's, measures the drop, scrolls the scroller back by it and translates from −drop to 0 on the same curve.
 *
 * Compositor-only per frame (one `translate`), nothing on <html>. Phones only; never for keyboard input or reduced
 * motion (input-mode). The ride, the fall and the composer's own morph (composer.ts, pills-composer.ts) all
 * follow KB_TRACK, the keyboard's track measured on a real iPhone. `localStorage["cf-kb-ms"]` overrides the
 * ride's duration (tests).
 */
const COMPOSER = "[data-app-composer]";
const EDITOR = '[data-app-composer] [contenteditable="true"]';
const SHELL = "[data-app-content-shell]";
const SCROLLER = "[data-page-scroll-viewport]";
/**
 * The keyboard's own motion on a real iPhone (17 Pro Max, iOS 27), measured frame by frame from kayg's 60fps
 * screen recordings of Claude's and ChatGPT's apps (2026-11-16): the fraction of its travel at each time (ms)
 * from its last frame at rest. Both apps' keyboards gave the same track within a frame's jitter, and so did
 * ChatGPT's dismiss (its composer fell on exactly these fractions). Driving the ride with these samples (linear
 * between them) keeps the composer on the keyboard's edge; Claude's composer rides within ~5% of it.
 * The earlier track (fitted from a ChatGPT recording) started at full speed (16.5% at 13ms) and skipped the
 * keyboard's slow first frame (4.8% at 17ms), so the composer ran up to ~40pt ahead early on; before that,
 * cubic-bezier(0.3, 1, 0.3, 1) had it ~70% up while the keyboard was at ~40%.
 */
const KB_MS = 350;
const KB_TRACK: [number, number][] = [
  [0, 0], [17, 0.048], [33, 0.19], [50, 0.334], [67, 0.472], [83, 0.597], [100, 0.69], [117, 0.767], [133, 0.83],
  [150, 0.875], [167, 0.907], [183, 0.934], [200, 0.952], [217, 0.967], [233, 0.976], [250, 0.982], [267, 0.988],
  [283, 0.991], [300, 0.994], [317, 0.997], [350, 1],
];
/** The same track as a CSS/WAAPI easing, for the composer's width and height (composer.ts, pills-composer.ts). */
export const KB_EASE = `linear(${KB_TRACK.map(([ms, f]) => `${f} ${((ms / KB_MS) * 100).toFixed(2)}%`).join(", ")})`;
export { KB_MS };
/** The track's fraction of travel at `ms`. */
const kbAt = (ms: number) => {
  const i = KB_TRACK.findIndex(([t]) => t >= ms);
  if (i <= 0) return i === 0 ? 0 : 1;
  const [t0, f0] = KB_TRACK[i - 1], [t1, f1] = KB_TRACK[i];
  return f0 + ((f1 - f0) * (ms - t0)) / (t1 - t0);
};
/**
 * The rest of the track from `elapsed` ms on, rescaled to 0→1 over the time left: for picking up a motion
 * mid-way toward a new target (bb's real height) without a change of speed. `[offset, fraction]` pairs.
 */
export function kbTail(elapsed: number): [number, number][] {
  const e = Math.min(Math.max(elapsed, 0), KB_MS - 1), fe = kbAt(e);
  return [[0, 0], ...KB_TRACK.filter(([t]) => t > e).map(([t, f]): [number, number] => [(t - e) / (KB_MS - e), (f - fe) / (1 - fe)])];
}
/** Keyframes for a translate from `from` to `to` (px) along the keyboard's track. */
const kbFrames = (from: number, to: number): Keyframe[] =>
  KB_TRACK.map(([ms, f]) => ({ offset: ms / KB_MS, translate: `0 ${(from + (to - from) * f).toFixed(1)}px` }));
/** Presses that are the composer's own controls, not the text field. */
const CONTROLS = "button, a, input, textarea, select, label, [role=button], [role=menuitem], [data-cf-kb]";
/** bb's composer opens its two-row form with this event (composer.ts beginOpen listens). */
export const OPEN_EVENT = "cf-composer-open";
/** composer.ts asks for a focus that rides with the keyboard (the model chip); cancelled when handled here. */
export const FOCUS_EVENT = "cf-composer-focus";

const editable = (el: Element | null) =>
  el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement);

export function mountKeyboardFollow(): () => void {
  const vv = window.visualViewport;
  if (!vv || navigator.maxTouchPoints === 0) return () => {};
  // Off switch (the stand-in field is a deep intervention): localStorage["cf-kb-follow"] = "off", then reload.
  try { if (localStorage.getItem("cf-kb-follow") === "off") return () => {}; } catch { /* private mode */ }
  const phone = matchMedia("(max-width: 767px)");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  const animates = () => document.documentElement.getAttribute("data-cf-input") !== "keys" && !reduced.matches;
  const duration = () => Number(localStorage.getItem("cf-kb-ms")) || KB_MS;
  let disposed = false;

  // The stand-in field. The same kind of field as bb's editor (contenteditable, same hints), so the keyboard
  // doesn't change when focus moves on. 16px text: iOS zooms into smaller fields.
  const proxy = document.createElement("div");
  proxy.contentEditable = "true";
  proxy.setAttribute("data-cf-kb-proxy", "");
  proxy.setAttribute("aria-hidden", "true");
  proxy.setAttribute("autocomplete", "off");
  proxy.setAttribute("enterkeyhint", "enter");
  proxy.tabIndex = -1;
  proxy.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;overflow:hidden;opacity:0;font-size:16px;line-height:1;padding:0;margin:0;border:0;outline:0;white-space:pre;pointer-events:none;z-index:-1";

  /** An open in progress: the stand-in has focus until the keyboard is up and the editor can take it. */
  type Hold = { shell: HTMLElement; top: string; h: number; pb: string };
  let opening: {
    editor: HTMLElement; composer: HTMLElement; range: Range | null; timer: number; hold: Hold | null;
    ride: { anim: Animation; mover: HTMLElement; scroller: HTMLElement | null; d: number } | null; lost: number; done: boolean; frame: number;
  } | null = null;
  /** The close's starting point, read before bb restores the shell (capture phase). */
  let closing: { composer: HTMLElement; before: number } | null = null;
  let falling: Animation | null = null;
  /** Set while our own focusout for bb (onProxyBlur) is being dispatched. */
  let synthetic = false;

  /**
   * The distance of the last ride, per display mode (the keyboard's height differs between a Safari tab and the
   * home-screen app): `lost` is the visible height the keyboard took, `extra` how much further the composer
   * moved (bb drops the bottom safe-area inset while the keyboard is up). Learned at every hand-over.
   */
  const memoryKey = () => `cf-kb-${(navigator as Navigator & { standalone?: boolean }).standalone ? "app" : "tab"}`;
  const memory = (): { lost: number; extra: number } => {
    try {
      const m = JSON.parse(localStorage.getItem(memoryKey()) ?? "null");
      if (m && Number.isFinite(m.lost) && Number.isFinite(m.extra)) return m;
    } catch { /* none yet */ }
    // First time: the iOS keyboard (with its bar) takes about 43% of the screen in the home-screen app and
    // 37% of it in a Safari tab, whose toolbar it covers (iPhone 18 Pro Max: 415 and 349 of 956pt).
    const app = (navigator as Navigator & { standalone?: boolean }).standalone;
    return { lost: Math.round(screen.height * (app ? 0.434 : 0.365)), extra: 0 };
  };
  const remember = (lost: number, extra: number) => {
    try { localStorage.setItem(memoryKey(), JSON.stringify({ lost: Math.round(lost), extra: Math.round(extra) })); } catch { /* private mode */ }
  };

  const bottomOf = (composer: HTMLElement) => composer.getBoundingClientRect().bottom;
  /**
   * What moves: the thread's scroller (messages and the sticky composer) and what scrolls it. The translate goes
   * on the scroller's parent (bb's `overflow: hidden` grid cell), not on the scroller: iOS doesn't composite a
   * transform animation on a scrolling element, so it only moved when the main thread drew, and the main thread
   * is busy while the keyboard comes up (the composer stood still, then jumped; simulator, 2026-11-16).
   */
  const moverOf = (composer: HTMLElement) => {
    const scroller = composer.closest<HTMLElement>(SCROLLER);
    return { scroller, mover: scroller?.parentElement ?? composer };
  };

  // ── Open ────────────────────────────────────────────────────────────────────────────────────────────────
  let touch: { x: number; y: number; moved: boolean } | null = null;
  const onTouchStart = (e: TouchEvent) => {
    touch = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, moved: false } : null;
  };
  const onTouchMove = (e: TouchEvent) => {
    const p = e.touches[0];
    if (touch && p && Math.hypot(p.clientX - touch.x, p.clientY - touch.y) > 10) touch.moved = true;
  };
  const onTouchEnd = (e: TouchEvent) => {
    const t = touch;
    touch = null;
    if (!t || t.moved || e.changedTouches.length !== 1 || !phone.matches || !animates() || opening) return;
    const target = e.target as Element | null;
    const composer = target?.closest?.<HTMLElement>(COMPOSER);
    if (!composer || target!.closest(CONTROLS)) return;
    const editor = composer.querySelector<HTMLElement>('[contenteditable="true"]');
    if (!editor || editor.contains(document.activeElement)) return;
    // Another field already has the keyboard up: focus moves without a reveal scroll anyway.
    if (editable(document.activeElement)) return;
    e.preventDefault(); // no native focus (and so no reveal scroll), no click
    const p = e.changedTouches[0];
    begin(editor, composer, caretAt(editor, p.clientX, p.clientY));
  };

  /** Where a tap put the caret, as a DOM position (it survives the composer moving). Only inside text. */
  function caretAt(editor: HTMLElement, x: number, y: number): Range | null {
    if (!(editor.textContent ?? "").trim()) return null;
    const range = document.caretRangeFromPoint?.(x, y) ?? null;
    return range && editor.contains(range.startContainer) ? range : null;
  }

  /**
   * The keyboard starts to rise a frame or two after the tap, but the visual viewport only reports its size
   * ~125ms later (home-screen app; measured 2026-11-16), so the ride starts here, with the remembered distance:
   * the shell is held at its current size (bb's re-layout when the viewport resizes changes nothing on screen),
   * and the thread's scroller translates up on the keyboard's curve. No layout is needed to start it.
   */
  function begin(editor: HTMLElement, composer: HTMLElement, range: Range | null) {
    const shell = composer.closest<HTMLElement>(SHELL);
    const cs = shell ? getComputedStyle(shell) : null;
    const hold = shell && cs ? { shell, top: cs.top, h: shell.getBoundingClientRect().height, pb: cs.paddingBottom } : null;
    if (!proxy.isConnected) document.body.append(proxy);
    proxy.textContent = "";
    proxy.focus({ preventScroll: true });
    if (document.activeElement !== proxy) { editor.focus(); return; } // refused: the plain way
    falling?.cancel();
    const o: NonNullable<typeof opening> = { editor, composer, range, timer: 0, hold, ride: null, lost: 0, done: false, frame: 0 };
    opening = o;
    // bb expands its composer from its own focus handler, and on a phone only once the keyboard's viewport
    // resize has come (bb waits for it, 350ms at most). The editor itself only gets focus at the hand-over,
    // so bb's two rows (+, model) used to arrive ~400ms after the keyboard had settled and popped in after the
    // motion. A focusin that bubbles from the editor (no real focus: the stand-in keeps it, so nothing
    // scrolls) starts bb's wait now: its rows come with the viewport resize, mid-ride, and morphHeight
    // carries the growth into them (2026-11-16).
    editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true, composed: true }));
    // Until the hand-over the composer looks as it will with the keyboard up (pills-composer.ts): bb's footer
    // toolbar stays hidden, the model pill keeps its name, and the row makes room for the keyboard-down button
    // (touch.ts adds it only once the editor has focus, so it popped in at the hand-over and pushed the mic).
    composer.setAttribute("data-cf-kb-open", "");
    if (hold) {
      hold.shell.style.setProperty("--cf-kb-hold-top", hold.top);
      hold.shell.style.setProperty("--cf-kb-hold-h", `${hold.h}px`);
      hold.shell.style.setProperty("--cf-kb-hold-pb", hold.pb);
      hold.shell.setAttribute("data-cf-kb-hold", "");
    }
    // The ride, and the composer's own morph (width, height: composer.ts beginOpen), start together in the next
    // frame, so the widening, the growth and the ride are one motion. iOS starts the keyboard as soon as it
    // learns of the focus, and the page can't see when; what it can see (iPhone 17 Pro simulator, load ~15,
    // 2026-11-16, /tmp/cfp-* on hd01): the page's main thread stalls right after the tap (rAF at 9–18ms, then
    // nothing until 110–160ms) and again when the viewport resizes (~130ms more), and the keyboard sometimes
    // moved all through those stalls (the viewport resize came at 116ms, i.e. ~80% up). An animation is
    // committed only after a stall, on the clock of the frame that made it, so it shows up where the
    // keyboard already is. Waiting for the stall to end before starting (tried) left the composer under the
    // risen keyboard, then jumped it up in one frame.
    o.frame = requestAnimationFrame(() => {
      o.frame = 0;
      if (opening !== o) return;
      composer.dispatchEvent(new CustomEvent(OPEN_EVENT, { bubbles: true }));
      if (!hold) return;
      const m = memory();
      const d = (o.lost || m.lost) + m.extra;
      const { mover, scroller } = moverOf(composer);
      // The end state is a real inline style, not `fill: forwards`: when WebKit's compositor finishes the
      // animation it drops its value until the main thread commits the fill, and under load (simulator) the
      // composer fell back down for a few frames.
      mover.style.translate = `0 ${(-d).toFixed(1)}px`;
      const anim = mover.animate(kbFrames(0, -d), { duration: duration(), easing: "linear" });
      o.ride = { anim, mover, scroller, d };
      anim.finished.then(() => { o.done = true; if (opening === o && o.lost) finishOpen(); }, () => {});
    });
    // The hand-over waits for the viewport's resize (handing over before bb's layout would put the editor
    // under the keyboard: iOS would scroll). It came up to 3.5s late in a heavily loaded simulator; if it never
    // comes (no keyboard at all), hand over anyway: the hand-over glides back to wherever bb's layout is.
    o.timer = window.setTimeout(() => { if (opening === o) finishOpen(); }, Math.max(duration() + 500, 2500));
  }

  /** The visual viewport has its keyboard-up size: the distance is now known; retarget if memory was off. */
  const onViewport = () => {
    const o = opening;
    if (!o || o.lost || document.activeElement !== proxy || !o.hold) return;
    const lost = o.hold.h - vv.height;
    if (lost < 20) return; // not a keyboard (a hardware keyboard still shows its small bar: ~50pt)
    o.lost = lost;
    if (o.ride) {
      const d = lost + memory().extra;
      if (Math.abs(d - o.ride.d) >= 1) {
        o.ride.mover.style.translate = `0 ${(-d).toFixed(1)}px`;
        // Same track, new distance (a plain two-keyframe list here turned the rest of the ride linear).
        (o.ride.anim.effect as KeyframeEffect).setKeyframes(kbFrames(0, -d));
        o.ride.d = d;
      }
    }
    if (o.done || (!o.ride && !o.frame)) finishOpen();
  };

  /** The keyboard is up: the real layout comes back, and the editor takes focus. */
  function finishOpen() {
    const o = opening;
    if (!o) return;
    opening = null;
    window.clearTimeout(o.timer);
    cancelAnimationFrame(o.frame);
    const shown = o.ride ? bottomOf(o.composer) : 0; // on screen: the held layout, ridden
    o.hold?.shell.removeAttribute("data-cf-kb-hold");
    if (o.ride) {
      const { anim, mover, scroller, d } = o.ride;
      anim.cancel();
      mover.style.removeProperty("translate");
      const off = shown - bottomOf(o.composer); // bb's layout: what the ride got wrong
      const real = d + off;
      // The messages stay where they are on screen: scrolled by the distance the scroller shrank.
      if (scroller) scroller.scrollTop += real;
      if (Math.abs(off) >= 1) mover.animate({ translate: [`0 ${off.toFixed(1)}px`, "0 0"] }, { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" });
      if (o.lost && Math.abs(real - o.lost) < 120) remember(o.lost, real - o.lost);
    }
    o.composer.removeAttribute("data-cf-kb-open");
    if (disposed || !o.editor.isConnected || document.activeElement !== proxy) return;
    const typed = proxy.textContent ?? "";
    proxy.textContent = "";
    o.editor.focus({ preventScroll: true });
    // touch.ts has put the keyboard-down button into the room the row kept for it: fade it in.
    o.composer.querySelector("[data-cf-kb]")?.animate({ opacity: [0, 1] }, { duration: 160, easing: "linear" });
    if (o.range) {
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(o.range);
    }
    if (typed) document.execCommand("insertText", false, typed);
  }

  /** Focus left the stand-in for somewhere else (a tap elsewhere, the app hid the keyboard): undo the hold. */
  const onProxyBlur = (e: FocusEvent) => {
    const o = opening;
    if (!o || e.relatedTarget === o.editor) return;
    opening = null;
    window.clearTimeout(o.timer);
    cancelAnimationFrame(o.frame);
    if (o.ride) {
      // Back down from wherever the ride is (the keyboard is going away too).
      const { anim, mover } = o.ride;
      const now = getComputedStyle(mover).translate;
      anim.cancel();
      mover.style.removeProperty("translate");
      const y = parseFloat((now ?? "").split(" ")[1] ?? "0") || 0;
      if (Math.abs(y) >= 1) mover.animate(kbFrames(y, 0), { duration: duration(), easing: "linear" });
    }
    o.hold?.shell.removeAttribute("data-cf-kb-hold");
    o.composer.removeAttribute("data-cf-kb-open");
    // bb saw a focusin (begin): its matching focusout lets it collapse again once the keyboard is down.
    // (Not a close of ours: the ride is already going back down above.)
    synthetic = true;
    try { o.editor.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true })); } finally { synthetic = false; }
  };

  // ── Close ───────────────────────────────────────────────────────────────────────────────────────────────
  const onFocusOutCapture = (e: FocusEvent) => {
    closing = null;
    if (synthetic) return;
    if (!phone.matches || !animates() || opening || !(e.target instanceof Element) || !e.target.closest(EDITOR)) return;
    const composer = e.target.closest<HTMLElement>(COMPOSER)!;
    if (e.relatedTarget instanceof Node && composer.contains(e.relatedTarget)) return;
    if (editable(e.relatedTarget as Element | null)) return; // the keyboard stays up
    closing = { composer, before: bottomOf(composer) };
  };
  /** On window, so it runs after bb's document listener has restored the full-height shell. */
  const onFocusOut = () => {
    const c = closing;
    closing = null;
    if (!c || !c.composer.isConnected) return;
    const d = bottomOf(c.composer) - c.before;
    if (d < 2) return;
    const { mover, scroller } = moverOf(c.composer);
    // The scroller grew at its bottom: scroll the content back by the same amount and lift the whole thing to
    // where it was, then let it fall with the keyboard.
    if (scroller) scroller.scrollTop -= d;
    falling?.cancel();
    falling = mover.animate(kbFrames(-d, 0), { duration: duration(), easing: "linear" });
  };

  /** composer.ts's model chip: focus the editor the smooth way, from a click. */
  const onFocusRequest = (e: Event) => {
    const editor = (e as CustomEvent<HTMLElement>).detail;
    const composer = editor?.closest?.<HTMLElement>(COMPOSER);
    if (!composer || opening || !phone.matches || !animates() || editable(document.activeElement)) return;
    e.preventDefault();
    begin(editor, composer, null);
  };

  document.addEventListener("touchstart", onTouchStart, { capture: true, passive: true });
  document.addEventListener("touchmove", onTouchMove, { capture: true, passive: true });
  document.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
  document.addEventListener("focusout", onFocusOutCapture, true);
  window.addEventListener("focusout", onFocusOut);
  window.addEventListener(FOCUS_EVENT, onFocusRequest);
  proxy.addEventListener("blur", onProxyBlur);
  vv.addEventListener("resize", onViewport);
  return () => {
    disposed = true;
    document.removeEventListener("touchstart", onTouchStart, { capture: true });
    document.removeEventListener("touchmove", onTouchMove, { capture: true });
    document.removeEventListener("touchend", onTouchEnd, { capture: true });
    document.removeEventListener("focusout", onFocusOutCapture, true);
    window.removeEventListener("focusout", onFocusOut);
    window.removeEventListener(FOCUS_EVENT, onFocusRequest);
    vv.removeEventListener("resize", onViewport);
    if (opening) {
      const o = opening;
      finishOpen();
      if (document.activeElement === proxy) o.editor.focus({ preventScroll: true });
    }
    falling?.cancel();
    proxy.removeEventListener("blur", onProxyBlur);
    proxy.remove();
    document.querySelectorAll("[data-cf-kb-hold]").forEach((el) => el.removeAttribute("data-cf-kb-hold"));
    document.querySelectorAll("[data-cf-kb-open]").forEach((el) => el.removeAttribute("data-cf-kb-open"));
  };
}

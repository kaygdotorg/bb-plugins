/**
 * The composer's buttons keep the keyboard up on phones (kayg: "every time I tap one of the buttons at the
 * bottom row of the composer, the keyboard is dismissed").
 *
 * Why it went down (traced in headless Chrome at phone size, 2026-11-16): on phones bb opens the +, model and
 * voice choices as bottom sheets (`[data-persistent-drawer-content]`), and on purpose blur()s the editor and
 * focus()es the sheet, since a sheet at the bottom of the layout would sit under the keyboard. iOS hides the
 * keyboard as soon as the editor loses focus. Tapping a button by itself doesn't blur anything on iOS.
 *
 * So, as phone-menu.ts does for ⋯: for a short window after a press on a composer button made while the editor
 * had focus, bb's blur() of the editor and its focus() of anything inside a sheet are skipped, and the sheet
 * that opens is lifted above the keyboard (its `bottom` = the keyboard's height, read from visualViewport,
 * kept up to date while it is open). A choice inside the sheet still moves focus as usual. Buttons that are
 * meant to end typing (Hide keyboard, Send, Stop, Steer) and attachment tiles are left alone.
 */
const DRAWER = "[data-persistent-drawer-content]";
const BUTTONS = "[data-app-composer] :is([data-promptbox-action-row], [data-follow-up-composer-footer]) button";
const SKIP = /hide keyboard|send|stop|steer|remove/i;
const WINDOW_MS = 1200;
const phone = () => matchMedia("(max-width: 767px) and (pointer: coarse)").matches;
const editing = (el: Element | null): el is HTMLElement =>
  !!el && ((el as HTMLElement).isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement);

/** The keyboard's height over the layout viewport (0 when it's down). */
const keyboardHeight = () => {
  const vv = window.visualViewport;
  return vv ? Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)) : 0;
};

export function mountKeepKeyboard(): () => void {
  let keep: { el: HTMLElement; until: number } | null = null;
  const active = () => !!keep && performance.now() < keep.until && keep.el.isConnected;
  const lifted = new Set<HTMLElement>();

  const prevFocus = HTMLElement.prototype.focus;
  const focus = function (this: HTMLElement, options?: FocusOptions) {
    if (active() && this !== keep!.el && this.closest(DRAWER)) return;
    return prevFocus.call(this, options);
  };
  const prevBlur = HTMLElement.prototype.blur;
  const blur = function (this: HTMLElement) {
    if (active() && this === keep!.el) return;
    return prevBlur.call(this);
  };
  HTMLElement.prototype.focus = focus;
  HTMLElement.prototype.blur = blur;

  const lift = () => {
    const kb = keyboardHeight();
    for (const d of lifted) {
      if (!d.isConnected) { lifted.delete(d); continue; }
      d.style.setProperty("bottom", `${kb}px`);
      d.style.setProperty("max-height", `${Math.max(200, innerHeight - kb - 24)}px`);
    }
  };
  // A sheet that appears during the window is one this press opened.
  const sheets = new MutationObserver((records) => {
    if (!active()) return;
    for (const r of records) for (const n of r.addedNodes) {
      if (!(n instanceof HTMLElement)) continue;
      const d = n.matches(DRAWER) ? n : n.querySelector<HTMLElement>(DRAWER);
      if (d) lifted.add(d);
    }
    if (lifted.size) lift();
  });
  sheets.observe(document.body, { childList: true });

  const onPointerDown = (e: PointerEvent) => {
    if (!e.isTrusted || !phone() || !(e.target instanceof Element)) return;
    const btn = e.target.closest<HTMLElement>(BUTTONS);
    if (!btn || SKIP.test(btn.getAttribute("aria-label") ?? btn.textContent ?? "")) return;
    const el = document.activeElement;
    keep = editing(el) ? { el, until: performance.now() + WINDOW_MS } : null;
  };
  document.addEventListener("pointerdown", onPointerDown, true);
  window.visualViewport?.addEventListener("resize", lift);

  return () => {
    if (HTMLElement.prototype.focus === focus) HTMLElement.prototype.focus = prevFocus;
    if (HTMLElement.prototype.blur === blur) HTMLElement.prototype.blur = prevBlur;
    document.removeEventListener("pointerdown", onPointerDown, true);
    window.visualViewport?.removeEventListener("resize", lift);
    sheets.disconnect();
    for (const d of lifted) { d.style.removeProperty("bottom"); d.style.removeProperty("max-height"); }
  };
}

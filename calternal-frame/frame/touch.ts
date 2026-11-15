/**
 * Phone behaviour bb doesn't have, installed by the content script (touch screens only):
 *  - Opening the sidebar drawer dismisses the keyboard, as iOS apps do; otherwise the
 *    keyboard squeezes the drawer's thread list to nothing.
 *  - When the visible area is short anyway, html gets [data-cf-short] and the sidebar
 *    scrolls as one column (css.ts) instead of collapsing its thread list.
 *  - Pull down at the top of the sidebar to open thread search.
 *  - While the keyboard is up for the composer, a keyboard-down button sits in its icon row.
 * Listeners are passive where possible and attached to single elements, never the DOM tree.
 */
import { mountSwipes } from "./swipe";

const SHELF = 'main[data-sidebar="inset"]';
const SIDEBAR = '[data-sidebar="sidebar"]';
const PULL_TRIGGER = 72; // px of pull, after resistance, that opens search
const SHORT_VIEWPORT = 560;

export function isEditing(el: Element | null): el is HTMLElement {
  return !!el && (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable);
}

/** Dismiss the keyboard when the drawer opens: watch only the one attribute bb flips. */
function watchDrawer(): () => void {
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      const main = r.target as HTMLElement;
      if (main.getAttribute("data-sidebar-shelf") === "open" && isEditing(document.activeElement) && main.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    }
  });
  const attach = () => {
    const main = document.querySelector(SHELF);
    if (main) observer.observe(main, { attributes: true, attributeFilter: ["data-sidebar-shelf"] });
  };
  attach();
  const timer = window.setInterval(attach, 2000); // main can be re-created on navigation
  return () => { window.clearInterval(timer); observer.disconnect(); };
}

/** Marks a short visible area (keyboard up, landscape) so the sidebar scrolls as one column. */
function watchViewport(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const update = () => document.documentElement.toggleAttribute("data-cf-short", vv.height < SHORT_VIEWPORT);
  update();
  vv.addEventListener("resize", update, { passive: true });
  return () => { vv.removeEventListener("resize", update); document.documentElement.removeAttribute("data-cf-short"); };
}

function openSearch() {
  const button = [...document.querySelectorAll<HTMLButtonElement>("[data-cf-nav] button")]
    .find((b) => /search/i.test(b.textContent ?? ""));
  button?.click();
}

/** Pull down at the top of the sidebar to search, with a small pill that says what happens. */
function pullToSearch(): () => void {
  const pill = document.createElement("div");
  pill.setAttribute("data-cf-pull", "");
  pill.setAttribute("aria-hidden", "true");
  let startY = 0, startX = 0, pull = 0, tracking = false, body: HTMLElement | null = null;

  const scroller = (sidebar: Element) => sidebar.querySelector<HTMLElement>('[data-sidebar="content"]');
  // bb's sidebar toggle is a separate fixed overlay: move it with the sidebar body.
  const toggle = () => document.querySelector<HTMLElement>('[data-testid="app-sidebar-trigger-overlay"]');
  const shift = (px: number, animate: boolean) => {
    for (const el of [body, toggle()]) {
      if (!el) continue;
      el.style.transition = animate ? "translate 220ms cubic-bezier(0.32,0.72,0,1)" : "none";
      el.style.translate = px ? `0 ${px}px` : "";
    }
  };
  const reset = () => {
    shift(0, true);
    pill.dataset.state = "";
    pill.style.opacity = "0";
    tracking = false;
    pull = 0;
  };

  const onStart = (e: TouchEvent) => {
    const sidebar = (e.target as Element).closest(SIDEBAR);
    const list = sidebar && scroller(sidebar);
    if (!sidebar || (list && list.scrollTop > 0) || e.touches.length !== 1) return;
    body = sidebar as HTMLElement;
    if (!pill.isConnected) body.prepend(pill);
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    tracking = true;
  };
  const onMove = (e: TouchEvent) => {
    if (!tracking || !body) return;
    const dy = e.touches[0].clientY - startY;
    const dx = e.touches[0].clientX - startX;
    // Vertical only: bb's own sideways swipes (drawer, panels) stay untouched.
    if (dy <= 0 || Math.abs(dx) > dy) { if (pull === 0) tracking = false; return; }
    pull = Math.min(140, dy * 0.5); // resistance
    shift(pull, false);
    pill.style.opacity = String(Math.min(1, pull / PULL_TRIGGER));
    pill.dataset.state = pull >= PULL_TRIGGER ? "ready" : "";
  };
  const onEnd = () => {
    if (!tracking) return;
    const fire = pull >= PULL_TRIGGER;
    reset();
    if (fire) { navigator.vibrate?.(8); openSearch(); }
  };

  document.addEventListener("touchstart", onStart, { passive: true });
  document.addEventListener("touchmove", onMove, { passive: true });
  document.addEventListener("touchend", onEnd, { passive: true });
  document.addEventListener("touchcancel", reset, { passive: true });
  return () => {
    document.removeEventListener("touchstart", onStart);
    document.removeEventListener("touchmove", onMove);
    document.removeEventListener("touchend", onEnd);
    document.removeEventListener("touchcancel", reset);
    pill.remove();
    shift(0, false);
  };
}

/** The keyboard is up when the visible area is much shorter than the layout and an editor has focus. */
function keyboardButton(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("data-cf-kb", "");
  button.setAttribute("aria-label", "Hide keyboard");
  button.style.cssText = "align-items:center;justify-content:center;width:2rem;height:2rem;border-radius:0.375rem;color:var(--muted-foreground);background:transparent;border:0;";
  // Lucide "keyboard" with a chevron-down under it.
  button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="12" rx="2"/><path d="M6 7h.01M10 7h.01M14 7h.01M18 7h.01M7 11h10"/><path d="m9 19 3 3 3-3"/></svg>';
  // pointerdown + preventDefault: the editor keeps focus until we blur it on purpose.
  button.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (isEditing(document.activeElement)) document.activeElement.blur();
  });

  const update = () => {
    const up = vv.height < window.innerHeight - 150 && isEditing(document.activeElement)
      && !!document.activeElement?.closest("[data-app-composer]");
    document.documentElement.toggleAttribute("data-cf-keyboard", up);
    if (!up) return;
    const group = document.activeElement?.closest("[data-app-composer]")?.querySelector("[data-promptbox-submit-group]");
    if (group && button.parentElement !== group) group.prepend(button);
  };
  vv.addEventListener("resize", update, { passive: true });
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", () => setTimeout(update, 0));
  return () => {
    vv.removeEventListener("resize", update);
    document.removeEventListener("focusin", update);
    button.remove();
    document.documentElement.removeAttribute("data-cf-keyboard");
  };
}

export function mountTouch(): () => void {
  // Any touch-capable device (iPhone, iPad, touch laptops); mouse-only desktops skip all of it.
  if (navigator.maxTouchPoints === 0) return () => {};
  const disposers = [watchDrawer(), watchViewport(), pullToSearch(), keyboardButton(), mountSwipes()];
  return () => { for (const dispose of disposers) dispose(); };
}

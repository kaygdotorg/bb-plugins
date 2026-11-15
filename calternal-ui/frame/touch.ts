/**
 * Phone behaviour bb doesn't have, installed by the content script (touch screens only):
 *  - Opening the sidebar drawer dismisses the keyboard, as iOS apps do; otherwise the
 *    keyboard squeezes the drawer's thread list to nothing.
 *  - When the visible area is short anyway, html gets [data-cf-short] and the sidebar
 *    scrolls as one column (css.ts) instead of collapsing its thread list.
 *  - Pull down to search: from the top of the sidebar, from the chat's title bar, or in a
 *    chat scrolled all the way up.
 *  - While the keyboard is up for the composer, a keyboard-down button sits in its icon row.
 *  - Swipe actions (swipe.ts).
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

/**
 * Marks a short visible area (keyboard up, landscape) so the sidebar scrolls as one column, and gives the
 * composer the visible height (--cf-vvh, for its editor's max height).
 *
 * Both go on the elements that use them, never on <html>, and only when they change: the visual viewport
 * resizes on every frame of the iOS keyboard's animation, and a custom property or attribute on the root
 * restyled the whole document each time (iPhone simulator, 2026-11-15: keyboard up 263ms worst frame,
 * keyboard down 83ms with 6 missed frames).
 */
function watchViewport(): () => void {
  const vv = window.visualViewport;
  if (!vv) return () => {};
  const update = () => {
    const short = vv.height < SHORT_VIEWPORT;
    const vvh = `${Math.round(vv.height)}px`;
    for (const s of document.querySelectorAll('[data-testid="app-layout-root"] [data-sidebar="sidebar"]')) {
      if (s.hasAttribute("data-cf-short") !== short) s.toggleAttribute("data-cf-short", short);
    }
    for (const c of document.querySelectorAll<HTMLElement>("[data-app-composer]")) {
      if (c.style.getPropertyValue("--cf-vvh") !== vvh) c.style.setProperty("--cf-vvh", vvh);
    }
  };
  update();
  vv.addEventListener("resize", update, { passive: true });
  document.addEventListener("focusin", update); // a composer or sidebar re-created on navigation
  const timer = window.setInterval(update, 2000);
  return () => {
    vv.removeEventListener("resize", update);
    document.removeEventListener("focusin", update);
    window.clearInterval(timer);
    document.querySelectorAll("[data-cf-short]").forEach((e) => e.removeAttribute("data-cf-short"));
  };
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
  let startY = 0, startX = 0, pull = 0, tracking = false;
  /** What moves with the finger: the sidebar body (+ its separate toggle), or the chat's messages. */
  let moving: HTMLElement[] = [];

  const shift = (px: number, animate: boolean) => {
    for (const el of moving) {
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

  /** Where a pull can start: the top of the sidebar, or the chat scrolled all the way up. */
  const begin = (target: Element): boolean => {
    const sidebar = target.closest<HTMLElement>(SIDEBAR);
    if (sidebar) {
      const list = sidebar.querySelector<HTMLElement>('[data-sidebar="content"]');
      if (list && list.scrollTop > 0) return false;
      const toggle = document.querySelector<HTMLElement>('[data-testid="app-sidebar-trigger-overlay"]');
      moving = toggle ? [sidebar, toggle] : [sidebar];
      sidebar.prepend(pill);
      pill.style.top = "0.5rem";
      return true;
    }
    // From the chat's title bar, at any scroll position: bb keeps long threads anchored and
    // loads older messages as you scroll up, so "scrolled to the very top" is rare there.
    const header = target.closest<HTMLElement>(`${SHELF} header`);
    if (header && !target.closest("button, a, input, [role=button]")) {
      const list = document.querySelector<HTMLElement>(`${SHELF} [data-timeline-row-list]`);
      // The bar stays put (as on iOS); the messages stretch under its frost.
      moving = list ? [list] : [];
      header.closest<HTMLElement>(SHELF)?.append(pill);
      pill.style.top = "calc(var(--bb-app-chrome-row-height, 3rem) + 0.75rem)";
      return true;
    }
    const viewport = target.closest<HTMLElement>(`${SHELF} [data-page-scroll-viewport]`);
    // Not from the composer: dragging there is text selection, not a pull.
    if (!viewport || viewport.scrollTop > 0 || target.closest("[data-app-composer]")) return false;
    const list = viewport.querySelector<HTMLElement>("[data-timeline-row-list]");
    if (!list) return false;
    moving = [list];
    const pane = viewport.closest<HTMLElement>(SHELF);
    pane?.append(pill);
    pill.style.top = "calc(var(--bb-app-chrome-row-height, 3rem) + 0.75rem)";
    return true;
  };

  const onStart = (e: TouchEvent) => {
    if (e.touches.length !== 1 || !begin(e.target as Element)) return;
    startY = e.touches[0].clientY;
    startX = e.touches[0].clientX;
    tracking = true;
  };
  const onMove = (e: TouchEvent) => {
    if (!tracking) return;
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

const COMPOSER_EDITOR = '[data-app-composer] [contenteditable="true"]';

/**
 * Keyboard-down button, shown while the composer's editor has focus on a touch device (on a
 * phone that means the keyboard is up). It sits right after bb's mic button and copies its
 * classes, so size and spacing match its neighbours.
 */
function keyboardButton(): () => void {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("data-cf-kb", "");
  button.setAttribute("aria-label", "Hide keyboard");
  // Lucide "keyboard" with a chevron-down under it.
  button.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="20" height="12" rx="2"/><path d="M6 7h.01M10 7h.01M14 7h.01M18 7h.01M7 11h10"/><path d="m9 19 3 3 3-3"/></svg>';
  // bb's composer refocuses its editor on any press inside it, which brought the keyboard
  // straight back: swallow every event of the press, then blur on purpose.
  const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  for (const type of ["pointerdown", "mousedown", "touchstart", "pointerup", "mouseup", "click"]) {
    button.addEventListener(type, swallow, { passive: false });
  }
  button.addEventListener("touchend", (e) => {
    swallow(e);
    (document.activeElement as HTMLElement | null)?.blur();
  }, { passive: false });
  button.addEventListener("click", () => (document.activeElement as HTMLElement | null)?.blur());

  const place = (editor: Element) => {
    const composer = editor.closest("[data-app-composer]");
    const mic = composer?.querySelector<HTMLButtonElement>('[data-promptbox-action-row] button[aria-label*="oice" i], [data-promptbox-action-row] button[aria-label*="ictat" i]');
    const anchor = mic ?? composer?.querySelector("[data-promptbox-submit-group]");
    if (!anchor) return;
    if (mic) {
      button.className = mic.className;
      if (button.previousElementSibling !== mic) mic.after(button);
    } else if (button.parentElement !== anchor) {
      anchor.prepend(button);
    }
  };
  // The mark goes on the composer, not <html> (a root attribute flip restyled the whole document while the
  // keyboard animated in; everything that reads it is inside the composer).
  let marked: Element | null = null;
  const update = () => {
    const editor = document.activeElement?.closest(COMPOSER_EDITOR) ?? null;
    const composer = editor?.closest("[data-app-composer]") ?? null;
    if (marked !== composer) {
      marked?.removeAttribute("data-cf-keyboard");
      composer?.setAttribute("data-cf-keyboard", "");
      marked = composer;
    }
    if (editor) place(editor);
  };
  const onFocusOut = () => setTimeout(update, 0);
  document.addEventListener("focusin", update);
  document.addEventListener("focusout", onFocusOut);
  return () => {
    document.removeEventListener("focusin", update);
    document.removeEventListener("focusout", onFocusOut);
    button.remove();
    marked?.removeAttribute("data-cf-keyboard");
  };
}

export function mountTouch(): () => void {
  // Any touch-capable device (iPhone, iPad, touch laptops); mouse-only desktops skip all of it.
  if (navigator.maxTouchPoints === 0) return () => {};
  const disposers = [watchDrawer(), watchViewport(), pullToSearch(), keyboardButton(), mountSwipes()];
  return () => { for (const dispose of disposers) dispose(); };
}

/**
 * The phone header's ⋯ menu as a morph (<768px; desktop: title-pill.ts, the reference). Read frame/pills.ts first.
 *
 * On phones bb opens the thread actions as its bottom action sheet, a persistent drawer
 * ([data-persistent-drawer-content]). When that drawer opens right after a press on the header's ⋯ (within
 * ARM_MS), it is marked data-cf-anchored and restyled as a context menu instead: fixed at the top right, its top
 * on the ⋯ pill's top and its right edge on the header toolbar's (>= 20px from the screen edges), as wide as its
 * content (max 280px), the menu glass, no drag handle and no slide. It is revealed by a clip-path that starts at
 * the ⋯ pill's exact rect and radius and grows to the menu's own (~220ms, --cf-ease-out); closing runs it
 * backwards into the pill (~160ms). Every item stays bb's own (submenus such as Notifications swap the drawer's
 * content in place, and the menu grows down from its top); a tap outside lands on bb's backdrop (made clear) and
 * closes it. Other drawers (the search palette, swipe's action sheets) are untouched.
 *
 * bb empties the drawer the moment it closes and keeps the (closed) element mounted. So the reverse morph runs
 * on a ghost: an inert copy of the menu as it last looked, taken whenever its content changes. The closed drawer
 * is "parked" (hidden, no transition) until it next opens, so it never slides from the top to its resting place.
 *
 * The press that opens the menu may release over it (the menu now covers the pill): its trailing pointer, mouse
 * and click events are swallowed inside the menu, so they never pick the item under the finger. Opened from the
 * keyboard, the menu is anchored without any motion; reduced motion swaps the morph for a short fade.
 */
import { R } from "./selectors";
import { clipMorph, stopMorph } from "./clip-morph";

const ACTIONS_SEL = `main header button[aria-label="Thread actions"]`;
const TOOLBAR_SEL = `main header div:has(> [data-thread-header-pane-actions])`;
const DRAWER_SEL = `[data-persistent-drawer-content]`;

/** A drawer opening this soon after a press on ⋯ is its menu. */
const ARM_MS = 600;
/** The opening press's trailing events are swallowed inside the menu for this long at most. */
const SWALLOW_MS = 600;
const OPEN_MS = 220;
const CLOSE_MS = 160;
/** Screen inset (Apple's phone margin) and the widest the menu gets. */
const INSET = 20;
const MAX_W = 280;

const frame = () => new Promise((r) => requestAnimationFrame(r));
const phone = () => matchMedia("(max-width: 767px)").matches;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** The anchored menu and its ghost share one look. */
const MENU = `${R} :is(${DRAWER_SEL}[data-cf-anchored]:not([data-cf-anchored="parked"]), [data-cf-am-ghost])`;

export const PHONE_MENU_CSS = `
@media (max-width: 767px) {
  /* bb's slide steps aside: the menu sits where it is placed, and is revealed by the clip alone. */
  ${R} ${DRAWER_SEL}[data-cf-anchored]:not([data-cf-anchored="parked"]) { transform: none !important; transition: none !important; }
  /* Closed (bb keeps it mounted, emptied): hidden where it is, with no slide back to bb's resting place. */
  ${R} ${DRAWER_SEL}[data-cf-anchored="prep"] { visibility: hidden !important; }
  ${R} ${DRAWER_SEL}[data-cf-anchored="parked"] { visibility: hidden !important; transition: none !important; }

  ${MENU} {
    position: fixed !important;
    top: var(--cf-am-top) !important;
    right: var(--cf-am-right) !important;
    left: auto !important;
    bottom: auto !important;
    margin: 0 !important;
    width: max-content !important;
    min-width: 0 !important;
    max-width: min(${MAX_W}px, 100vw - ${2 * INSET}px) !important;
    /* The visible area, not the screen: with the keyboard up the menu ended under its toolbar (simulator). */
    max-height: var(--cf-am-max, calc(100dvh - var(--cf-am-top) - ${INSET}px)) !important;
    /* The menus' glass and corners (css.ts "Every floating menu"): radius 14 = item 8 + padding 6. */
    border-radius: var(--cf-radius) !important;
    padding: 6px !important;
    border: 1px solid color-mix(in oklab, var(--foreground) 10%, transparent) !important;
    background: var(--cf-glass-fill) !important; /* the one glass (css.ts --cf-glass) */
    -webkit-backdrop-filter: var(--cf-glass) !important;
    backdrop-filter: var(--cf-glass) !important;
    box-shadow: var(--cf-glass-highlight), 0 12px 32px -10px rgb(0 0 0 / 0.35), 0 2px 6px -2px rgb(0 0 0 / 0.12) !important;
    overflow: clip !important;
    --state-hover: color-mix(in oklab, var(--cf-accent) 26%, transparent);
    --state-active: color-mix(in oklab, var(--cf-accent) 26%, transparent);
    --accent: color-mix(in oklab, var(--cf-accent) 26%, transparent);
  }
  ${MENU} [data-persistent-drawer-handle] { display: none !important; }
  /* The item list scrolls inside the menu; the menu's padding is the only ring. */
  ${MENU} > div:not([data-persistent-drawer-handle]) { padding: 0 !important; overflow-x: hidden !important; }
  ${MENU} hr { margin-inline: 2px !important; }
  ${MENU} [role="menuitem"] { border-radius: calc(var(--cf-radius) - 6px) !important; }
  ${R} [data-cf-am-ghost] { pointer-events: none !important; z-index: 60; }

  /* A context menu, not a sheet: no scrim. The (clear) backdrop still takes the tap outside that closes it. */
  ${R} [data-persistent-drawer-backdrop][data-cf-anchored] { background: transparent !important; }

  /* The menu covers the ⋯ pill; its glyph steps out so it never shows through the menu's glass. */
  ${R} ${ACTIONS_SEL}[data-cf-am-open] :is(svg, span.size-4) { opacity: 0; }
}
`;

type Snap = { clone: HTMLElement; rect: DOMRect };

export function mountPhoneMenu(): () => void {
  const root = document.documentElement;
  let armed: { t: number; still: boolean } = { t: -Infinity, still: false };
  let swallowUntil = 0;
  let live: {
    drawer: HTMLElement;
    backdrop: HTMLElement | null;
    button: HTMLElement;
    content: MutationObserver;
    snap: Snap | null;
  } | null = null;
  let ghost: HTMLElement | null = null;
  const watched = new WeakSet<Element>();

  const actions = () => document.querySelector<HTMLElement>(ACTIONS_SEL);

  /**
   * Keep the keyboard up. Tapping ⋯ while typing closed the iOS keyboard: bb's ⋯ click handler blur()s the
   * text field on purpose (its bottom sheet would sit under the keyboard), and iOS hides the keyboard when the
   * field loses focus. Our menu is anchored at the top, clear of the keyboard, so for a short window after a ⋯
   * press made while a text field had focus, that field's blur() and focus() calls on elements inside a drawer
   * are skipped (traced in headless Chrome, 2026-11-15). Tapping a menu item still moves focus as usual. The
   * originals are restored on unmount.
   */
  let keep: { el: HTMLElement; until: number } | null = null;
  const nativeFocus = HTMLElement.prototype.focus;
  const guardedFocus = function (this: HTMLElement, options?: FocusOptions) {
    if (keep && performance.now() < keep.until && keep.el.isConnected && this !== keep.el && this.closest(DRAWER_SEL)) return;
    return nativeFocus.call(this, options);
  };
  HTMLElement.prototype.focus = guardedFocus;
  const nativeBlur = HTMLElement.prototype.blur;
  const guardedBlur = function (this: HTMLElement) {
    if (keep && performance.now() < keep.until && this === keep.el && phone()) return;
    return nativeBlur.call(this);
  };
  HTMLElement.prototype.blur = guardedBlur;
  const inMenu = (t: EventTarget | null) => !!live && t instanceof Node && live.drawer.contains(t);

  // ── Input: remember the press (or key) on ⋯ that is about to open a drawer.
  const onPointerDown = (e: PointerEvent) => {
    if (!e.isTrusted || e.button !== 0 || !phone()) return;
    const btn = actions();
    if (!btn || !(e.target instanceof Node) || !btn.contains(e.target)) return;
    armed = { t: performance.now(), still: false };
    swallowUntil = armed.t + SWALLOW_MS;
    // The keyboard stays up: see keepFocus below.
    const active = document.activeElement as HTMLElement | null;
    const editing = !!active && (active.isContentEditable || active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement);
    keep = editing ? { el: active!, until: armed.t + ARM_MS + 400 } : null;
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!phone() || !["Enter", " "].includes(e.key)) return;
    const btn = actions();
    if (btn && document.activeElement === btn) armed = { t: performance.now(), still: true };
  };
  /** The opening press's trailing events land on the menu that now covers the pill: they are not for its items. */
  const swallow = (e: Event) => {
    if (!e.isTrusted || performance.now() > swallowUntil || !inMenu(e.target)) return;
    e.stopPropagation();
    e.preventDefault();
    if (e.type === "click") swallowUntil = 0; // the press is over
  };
  /** Any later press inside the menu is a real one. */
  const onLaterDown = (e: PointerEvent) => { if (inMenu(e.target)) swallowUntil = 0; };

  // ── Drawers: watch each one's data-state (bb keeps them mounted between openings).
  const states = new MutationObserver((records) => {
    for (const rec of records) {
      const d = rec.target as HTMLElement;
      const state = d.getAttribute("data-state");
      if (state === rec.oldValue) continue;
      if (state === "open") opened(d);
      else if (state === "closed") closed(d);
    }
  });
  const watch = (d: Element) => {
    if (watched.has(d)) return;
    watched.add(d);
    states.observe(d, { attributes: true, attributeFilter: ["data-state"], attributeOldValue: true });
    if (d.getAttribute("data-state") === "open") opened(d as HTMLElement);
  };
  const portals = new MutationObserver((records) => {
    for (const rec of records) for (const n of rec.addedNodes) if (n instanceof HTMLElement && n.matches(DRAWER_SEL)) watch(n);
  });

  function opened(drawer: HTMLElement) {
    if (drawer.getAttribute("data-cf-anchored") === "parked") drawer.removeAttribute("data-cf-anchored");
    if (live?.drawer === drawer) return;
    const now = performance.now();
    const btn = actions();
    if (!btn || !phone() || now - armed.t > ARM_MS || root.hasAttribute("data-cf-silent-menu")) return;
    const label = document.getElementById(drawer.getAttribute("aria-labelledby") ?? "")?.textContent?.trim();
    if (label && label !== "Thread actions") return;
    const motion = !armed.still && root.getAttribute("data-cf-input") !== "keys";
    armed = { t: -Infinity, still: false };
    ghost?.remove();
    ghost = null;

    // Place it: top on the pill's top, right edge on the toolbar's, never closer than INSET to the screen's edges.
    const p = btn.getBoundingClientRect();
    // The header's right toolbar is hidden on phones (its buttons are this menu's first items), so the
    // ⋯ pill is the header's right end. (A visible toolbar still widens the anchor, e.g. mid-resize.)
    const tb = btn.closest("main")?.querySelector(TOOLBAR_SEL)?.getBoundingClientRect();
    // The screen inset is the header's (--cf-ph-side: 16 or 20 by screen width), so the menu's edge stays on the pill's.
    const inset = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cf-ph-side")) || INSET;
    const right = Math.max(inset, innerWidth - Math.max(p.right, tb && tb.width > 0 ? tb.right : p.right));
    const top = Math.max(INSET / 2, p.top);
    drawer.style.setProperty("--cf-am-top", `${top}px`);
    drawer.style.setProperty("--cf-am-right", `${right}px`);
    const visible = window.visualViewport ? window.visualViewport.offsetTop + window.visualViewport.height : innerHeight;
    drawer.style.setProperty("--cf-am-max", `${Math.max(120, visible - top - INSET)}px`);
    // "prep": placed but hidden until bb has rendered its items (it fills the drawer a frame or so after opening).
    drawer.setAttribute("data-cf-anchored", "prep");
    const backdrop = [...document.querySelectorAll<HTMLElement>("[data-persistent-drawer-backdrop]")].find((b) => b.getAttribute("data-state") === "open") ?? null;
    backdrop?.setAttribute("data-cf-anchored", "");
    btn.setAttribute("data-cf-am-open", "");

    const content = new MutationObserver(() => schedule());
    content.observe(drawer, { childList: true, subtree: true });
    const me = { drawer, backdrop, button: btn, content, snap: null };
    live = me;
    void (async () => {
      for (let i = 0; i < 20 && !drawer.querySelector('[role="menuitem"]'); i++) await frame();
      if (live !== me) return;
      inject(drawer);
      drawer.setAttribute("data-cf-anchored", "on");
      snapshot();
      if (motion) void run(drawer, btn, true);
    })();
  }

  /** A copy of the menu as it looks now, for the reverse morph (bb empties it the moment it closes). */
  let pending = 0;
  function schedule() {
    if (pending) return;
    pending = requestAnimationFrame(() => { pending = 0; if (live) inject(live.drawer); snapshot(); });
  }
  /**
   * The header's right toolbar (the right-panel button, and any workflow buttons bb adds there) is hidden on
   * phones (pills-phone.ts): its buttons become this menu's first items, in the menu's own item style, then a
   * separator. A tap closes the menu (a tap on bb's backdrop, as outside) and presses bb's own button. bb
   * re-renders the items when a submenu goes back, so this runs again on every content change.
   */
  function inject(drawer: HTMLElement) {
    if (drawer.querySelector("[data-cf-am-tool]")) return;
    const first = drawer.querySelector<HTMLElement>('[role="menuitem"]');
    const tools = [...document.querySelectorAll<HTMLButtonElement>(`${TOOLBAR_SEL} button`)].filter((b) => !b.disabled);
    if (!first?.parentElement || !tools.length) return;
    const list = first.parentElement;
    const anchor = list.firstElementChild;
    for (const tool of tools) {
      const item = document.createElement("div");
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
      item.setAttribute("data-cf-am-tool", "");
      item.className = first.className;
      // "Show right panel (Ctrl + J)" → "Show right panel": shortcuts mean nothing on a phone.
      const label = (tool.getAttribute("aria-label") ?? tool.textContent ?? "").replace(/\s*\([^)]*\)\s*$/, "").trim();
      item.innerHTML = `${tool.querySelector("svg")?.outerHTML ?? ""}<span></span>`;
      item.querySelector("span")!.textContent = label;
      item.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const backdrop = live?.backdrop;
        if (backdrop) for (const type of ["pointerdown", "pointerup", "click"]) backdrop.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
        tool.click();
      });
      list.insertBefore(item, anchor);
    }
    const hr = drawer.querySelector("hr")?.cloneNode(true) as HTMLElement | undefined;
    if (hr) { hr.setAttribute("data-cf-am-tool", ""); list.insertBefore(hr, anchor); }
  }

  function snapshot() {
    if (!live || live.drawer.getAttribute("data-state") !== "open" || !live.drawer.querySelector('[role="menuitem"]')) return;
    live.snap = { clone: live.drawer.cloneNode(true) as HTMLElement, rect: live.drawer.getBoundingClientRect() };
  }

  function closed(drawer: HTMLElement) {
    if (!live || live.drawer !== drawer) return;
    const { backdrop, button, content, snap } = live;
    content.disconnect();
    if (pending) { cancelAnimationFrame(pending); pending = 0; }
    live = null;
    swallowUntil = 0;
    stopMorph(drawer);
    drawer.getAnimations({ subtree: true }).forEach((a) => a.cancel());
    drawer.setAttribute("data-cf-anchored", "parked");
    backdrop?.removeAttribute("data-cf-anchored");
    const motion = root.getAttribute("data-cf-input") !== "keys" && !!snap && phone() && button.isConnected;
    if (!motion) { button.removeAttribute("data-cf-am-open"); return; }

    // The ghost: an inert copy at the menu's last rect, morphing back into the pill.
    const g = snap.clone;
    for (const a of [...g.attributes]) if (a.name !== "class" && a.name !== "style") g.removeAttribute(a.name);
    g.setAttribute("data-cf-am-ghost", "");
    g.setAttribute("aria-hidden", "true");
    g.inert = true;
    g.style.removeProperty("transform");
    g.style.removeProperty("transition");
    g.style.setProperty("width", `${snap.rect.width}px`, "important");
    g.style.setProperty("height", `${snap.rect.height}px`, "important");
    document.body.append(g);
    ghost = g;
    const done = run(g, button, false);
    void done.then(() => {
      if (ghost === g) { g.remove(); ghost = null; }
      if (!live) button.removeAttribute("data-cf-am-open");
    });
  }

  /** One direction of the morph: a clip from the pill's rect and radius to the menu's own, and back. */
  function run(menu: HTMLElement, pill: HTMLElement, opening: boolean): Promise<unknown> {
    if (still()) {
      const a = menu.animate({ opacity: opening ? [0, 1] : [1, 0] }, { duration: opening ? 120 : 90, easing: "linear", fill: "both" });
      return a.finished.then(() => { if (opening) a.cancel(); }, () => {});
    }
    // Main-thread clip (clip-morph.ts explains the compositor flicker this avoids).
    return clipMorph(menu, pill, opening, opening
      ? { ms: OPEN_MS, fadeDelay: 50, fadeMs: 150, fadeEase: "out" }
      : { ms: CLOSE_MS, fadeDelay: 0, fadeMs: 80, fadeEase: "linear" });
  }

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("pointerdown", onLaterDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  const TRAILING = ["pointerup", "mousedown", "mouseup", "click"];
  for (const t of TRAILING) document.addEventListener(t, swallow, true);
  portals.observe(document.body, { childList: true });
  document.querySelectorAll(DRAWER_SEL).forEach(watch);

  return () => {
    if (HTMLElement.prototype.focus === guardedFocus) HTMLElement.prototype.focus = nativeFocus;
    if (HTMLElement.prototype.blur === guardedBlur) HTMLElement.prototype.blur = nativeBlur;
    keep = null;
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("pointerdown", onLaterDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    for (const t of TRAILING) document.removeEventListener(t, swallow, true);
    portals.disconnect();
    states.disconnect();
    live?.content.disconnect();
    live?.backdrop?.removeAttribute("data-cf-anchored");
    live?.button.removeAttribute("data-cf-am-open");
    live?.drawer.removeAttribute("data-cf-anchored");
    document.querySelectorAll(`${DRAWER_SEL}[data-cf-anchored]`).forEach((d) => d.removeAttribute("data-cf-anchored"));
    ghost?.remove();
    live = null;
  };
}

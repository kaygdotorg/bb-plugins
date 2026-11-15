/**
 * The desktop chat header's title pill (>= 768px; phones: pills-phone.ts). Read frame/pills.ts first.
 *
 * One glass capsule holds just the thread title. bb's ⋯ (Thread actions) button stays in the DOM as the
 * menu's trigger, stretched invisibly over the whole pill, so the pill IS the button (keyboard too:
 * Tab focuses it, Enter/Space opens the menu, with no animation).
 *   - A press opens bb's own thread actions menu as a MORPH, on pointer-down, with no wait: the menu
 *     starts at the pill's exact rect and radius and grows to its own (clip-path, ~200ms, a strong
 *     ease-out, driven by clip-morph.ts); the pill hides while it is open, and closing runs it backwards (~150ms).
 *   - A second press within DOUBLE_MS (a double click) closes the menu at once, with no animation, and
 *     renames the thread inline: bb's own "Rename" item swaps the title for its inline editor (Enter
 *     saves, Escape cancels, blur saves); it runs with the menu invisible (html[data-cf-silent-menu],
 *     as swipe.ts does) and the editor is restyled to sit exactly where the title was. A menu that
 *     opens and vanishes within a double-click interval is the price of an instant single click.
 *
 * Motion follows emilkowal.ski/ui/7-practical-animation-tips: under 300ms, a strong ease-out
 * (cubic-bezier(0.23, 1, 0.32, 1)), grow from the trigger, the press scales to 0.97. Only clip-path
 * and opacity move. The glass is never scaled or faded (a blur under a moving layer ghosts); the
 * menu is revealed by a clip-path from the pill's rect and radius to its own. The menu is first
 * moved (the wrapper's `translate`, which composes with Radix's own `transform`) so that its
 * top-left corner is the pill's, and it is at least as wide as the pill. Reduced motion swaps the
 * morph for a short fade; keyboard actions never animate.
 *
 * While a press may still release over the menu (it now overlaps the pill) the menu ignores the
 * pointer, and the press's own mouse events are swallowed, so Radix's "release selects the item
 * under the pointer" can never trigger Copy link.
 *
 * Radix keeps a closing menu mounted only while a CSS animation runs on it, so a `cf-hold`
 * keyframe (no visible change) lasts as long as the reverse morph.
 */
import { R } from "./selectors";
import { GLASS_LAYER, s } from "./pills";
import { clipMorph, stopMorph } from "./clip-morph";

const ROW = `${R} main header [data-testid="app-page-header-content-row"]`;
/** The pill: the row's left cell's only child (bb: title wrapper + the ⋯ span). */
const PILL = `${ROW} > div:first-child > div`;
const PILL_SEL = `main header [data-testid="app-page-header-content-row"] > div:first-child > div`;
const ACTIONS_SEL = `main header button[aria-label="Thread actions"]`;
const EDITOR = "[data-sidebar-rename-editor]";

/** A second press this soon after the first, on the pill, is a double click. */
const DOUBLE_MS = 400;
/** After a press the menu ignores the pointer for this long (see the header comment). */
const GUARD_MS = 450;
/** Emil Kowalski's strong ease-out. */
const OPEN_MS = 200;
const CLOSE_MS = 150;

const wide = () => matchMedia("(min-width: 768px)").matches;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const TITLE_PILL_CSS = `
@media (min-width: 768px) {
  /* ── The pill: the title alone, equal padding both sides. Words sit on this glass and page text
     passes under it, so the tint is denser than the icon pills' (as the phone capsule's), for >= 4.5:1. */
  ${PILL} {
    position: relative;
    isolation: isolate;
    display: flex;
    align-items: center;
    height: var(--cf-text-h);
    padding: 0 var(--cf-text-pad);
    border-radius: 999px;
    /* The card's top-left corner is the 62px device radius: the same inset past bb's as the toolbar's right (pills.ts). */
    margin-left: var(--cf-hd-inset);
    cursor: default;
    user-select: none;
    --cf-pill-alpha: 0; /* the one glass, as every pill */
    transition: scale 150ms var(--cf-ease-out);
  }
  ${PILL}::before {
${GLASS_LAYER}}
  /* The hover tint is its own layer above the glass (a background on the pill itself would paint under it). */
  ${PILL}::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    pointer-events: none;
    transition: background-color 150ms ease;
  }
  @media (hover: hover) {
    ${PILL}:not(:has(${EDITOR})):hover::after { background: var(--cf-pill-hover); }
  }
  ${PILL}:not(:has(${EDITOR})):active { scale: 0.97; }
  ${PILL}:has(button:focus-visible) { outline: 2px solid var(--ring, var(--cf-accent)); outline-offset: 2px; }

  /* The title: one line, truncating; the pill's own words. */
  ${PILL} > div { min-width: 0; }
  ${PILL} p {
    font-size: ${s(14)};
    font-weight: 600;
    letter-spacing: -0.01em;
    line-height: 1.2;
    color: var(--foreground);
  }
  ${PILL} p * { color: inherit; }

  /* bb's ⋯ stays as the menu's trigger, invisible and stretched over the whole pill: a press anywhere on
     the pill is a press on it, Radix anchors the menu to the pill, and the keyboard reaches it. */
  ${PILL} > span { display: contents; }
  ${PILL} button[aria-label="Thread actions"] {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    border-radius: 999px;
    opacity: 0;
    background: transparent !important;
    cursor: default;
  }
  ${PILL} button[aria-label="Thread actions"] :is(svg, span.size-4) { display: none; }
  /* While renaming, the editor takes the pointer. */
  ${PILL}[data-cf-renaming] button[aria-label="Thread actions"] { pointer-events: none; } /* marks.ts */

  /* ── Inline rename (bb's editor, restyled to sit exactly where the title was). */
  ${PILL}:has(${EDITOR}) { user-select: auto; cursor: text; }
  ${PILL} ${EDITOR} { gap: 0; }
  ${PILL} ${EDITOR} input {
    font: inherit;
    letter-spacing: inherit;
    line-height: inherit;
    color: var(--foreground);
    caret-color: var(--cf-accent, currentColor);
    user-select: text;
  }

  /* ── The morph. While the menu is open the pill is hidden: its glass at once (the menu's glass takes
     over at the same rect), its words in a short fade. */
  ${PILL}[data-cf-open]::before, ${PILL}[data-cf-open]::after { visibility: hidden; }
  ${PILL}[data-cf-open] > div { opacity: 0; transition: opacity 90ms linear; }
  ${PILL}:not([data-cf-open]) > div { transition: opacity 120ms ease-out; }

  /* The menu, mid-morph: bb's own open/close animation steps aside. "prep" is the frame or two
     before it has been placed. */
  ${R} [role="menu"][data-cf-morph] { animation: none !important; }
  ${R} [role="menu"][data-cf-morph="prep"] { visibility: hidden; }
  ${R} [role="menu"][data-cf-guard] { pointer-events: none !important; }
  ${R} [role="menu"][data-cf-morph="on"][data-state="closed"] { animation: cf-hold var(--cf-hold, ${CLOSE_MS}ms) linear both !important; }
  @keyframes cf-hold { from { outline-offset: 0; } to { outline-offset: 0; } }
}
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));

export function mountTitlePill(): () => void {
  const root = document.documentElement;
  let armedAt = 0; // our press asked for the menu: its opening is a morph
  let lastDown = { t: 0, x: 0, y: 0 };
  let swallowUntil = 0;
  let live: { wrapper: HTMLElement; menu: HTMLElement; pill: HTMLElement; attrs: MutationObserver } | null = null;

  const pillOf = (el: EventTarget | null) => (el instanceof Element ? (el.closest(PILL_SEL) as HTMLElement | null) : null);
  const actions = () => document.querySelector<HTMLElement>(ACTIONS_SEL);
  const pill = () => pillOf(actions());
  const editing = () => !!pill()?.querySelector(EDITOR);
  /** Is the pointer on the pill? By coordinates: while a menu covers the pill, it is not the event's target. */
  const onPill = (e: MouseEvent) => {
    const r = pill()?.getBoundingClientRect();
    return !!r && e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
  };
  const pressActions = () =>
    actions()?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }));
  const menuOf = () => {
    const id = actions()?.id;
    return id ? document.querySelector<HTMLElement>(`[role="menu"][aria-labelledby="${id}"]`) : null;
  };

  // ── Input. A real pointer press starts everything on pointer-down: bb's ⋯ opens on pointer-down too, so
  // nothing waits for the click. The press's own follow-up mouse events are swallowed on the pill.
  const onPointerDown = (e: PointerEvent) => {
    if (!e.isTrusted || e.button !== 0 || !wide() || editing() || !onPill(e)) return;
    const now = performance.now();
    // data-cf-double-ms: a test hook, for browsers too slow to deliver two presses in 400ms.
    const window_ = Number(root.dataset.cfDoubleMs) || DOUBLE_MS;
    const double = now - lastDown.t < window_ && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 8;
    lastDown = { t: now, x: e.clientX, y: e.clientY };
    swallowUntil = now + DOUBLE_MS + 100;
    // Radix's own handlers must not see it (an outside press would close the menu, a button press toggle it).
    e.stopPropagation();
    e.preventDefault();
    if (double) void rename();
    else if (!menuOf()) {
      armedAt = now;
      pressActions();
    }
  };
  /** The press's pointer-up, mouse and click events on the pill, which a menu now covers, are not for the menu's items. */
  const swallow = (e: MouseEvent) => {
    if (!e.isTrusted || performance.now() > swallowUntil || editing() || !onPill(e)) return;
    e.stopPropagation();
    e.preventDefault();
  };
  /** Keys that act on the menu must never animate: its morph steps aside. */
  const onKey = (e: KeyboardEvent) => {
    if (live && ["Escape", "Enter", " ", "Tab"].includes(e.key)) live.menu.setAttribute("data-cf-morph", "still");
  };

  /** A double click: the menu goes at once, and bb's own Rename item swaps the title for its inline editor. */
  async function rename() {
    const btn = actions();
    if (!btn) return;
    root.setAttribute("data-cf-silent-menu", "");
    try {
      const open = menuOf();
      if (open) {
        // Opened by the first press of this double click: drop the morph, no animation.
        open.setAttribute("data-cf-morph", "still");
        stopMorph(open);
        open.getAnimations({ subtree: true }).forEach((a) => a.cancel());
      } else pressActions();
      for (let i = 0; i < 40; i++) {
        const item = [...(menuOf()?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])].find((el) => /^Rename/.test(el.textContent?.trim() ?? ""));
        if (item) { item.click(); return; }
        await sleep(16);
      }
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); // not found: close it
    } finally {
      setTimeout(() => root.removeAttribute("data-cf-silent-menu"), 250);
    }
  }

  // ── The morph.
  /** The menu mounted: move it over the pill, and open it as a morph if our press asked for it. */
  async function begin(wrapper: HTMLElement, menu: HTMLElement, pillEl: HTMLElement) {
    const animated = performance.now() - armedAt < 600;
    menu.setAttribute("data-cf-morph", "prep");
    if (animated) {
      menu.setAttribute("data-cf-guard", "");
      setTimeout(() => menu.removeAttribute("data-cf-guard"), GUARD_MS);
    }
    menu.style.minWidth = `${pillEl.getBoundingClientRect().width}px`;
    const attrs = new MutationObserver(() => end());
    live = { wrapper, menu, pill: pillEl, attrs };
    attrs.observe(menu, { attributes: true, attributeFilter: ["data-state"] });

    // Radix places its wrapper a frame or so after mounting (until then: translate(0, -200%)).
    for (let i = 0; i < 12 && /-200%/.test(wrapper.style.transform || "-200%"); i++) await frame();
    if (live?.menu !== menu || menu.getAttribute("data-cf-morph") !== "prep") return;
    // Top-left corner onto the pill's: `translate` composes with Radix's own transform.
    wrapper.style.translate = "0 0";
    const m = menu.getBoundingClientRect();
    const p = pillEl.getBoundingClientRect();
    wrapper.style.translate = `${p.left - m.left}px ${p.top - m.top}px`;

    // The pill hides only now, in the same frame the menu appears over it (not while it is placed).
    pillEl.setAttribute("data-cf-open", "");
    if (!animated) { menu.setAttribute("data-cf-morph", "still"); return; }
    menu.setAttribute("data-cf-morph", "on");
    run(menu, pillEl, true);
  }

  /** The menu's closing (data-state flipped): reverse the morph if it is still ours. */
  function end() {
    if (!live) return;
    const { menu, pill: pillEl } = live;
    if (menu.getAttribute("data-state") !== "closed" || menu.getAttribute("data-cf-morph") !== "on") return;
    run(menu, pillEl, false);
  }

  /** One direction of the morph. The open one is origin-aware: it grows from the pill's own rect and radius. */
  function run(menu: HTMLElement, pillEl: HTMLElement, opening: boolean) {
    if (still()) {
      // Reduced motion: a short fade in place of the movement.
      const ms = opening ? 120 : 90;
      const a = menu.animate({ opacity: opening ? [0, 1] : [1, 0] }, { duration: ms, easing: "linear", fill: "both" });
      if (opening) void a.finished.then(() => a.cancel(), () => {});
      return;
    }
    // Main-thread clip (clip-morph.ts explains the compositor flicker this avoids).
    void clipMorph(menu, pillEl, opening, opening
      ? { ms: OPEN_MS, fadeDelay: 40, fadeMs: 140, fadeEase: "out" }
      : { ms: CLOSE_MS, fadeDelay: 0, fadeMs: 70, fadeEase: "linear" });
  }

  /** Watches only the body's direct children (portals): a menu of ⋯ arriving, or its wrapper leaving. */
  const portals = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (!(node instanceof HTMLElement) || !node.hasAttribute("data-radix-popper-content-wrapper")) continue;
        if (root.hasAttribute("data-cf-silent-menu") || !wide()) continue;
        const menu = node.querySelector<HTMLElement>('[role="menu"]');
        const btn = actions();
        const pillEl = pillOf(btn);
        if (menu && btn && pillEl && menu.getAttribute("aria-labelledby") === btn.id) void begin(node, menu, pillEl);
      }
      for (const node of rec.removedNodes) {
        if (live && node === live.wrapper) {
          live.attrs.disconnect();
          live.pill.removeAttribute("data-cf-open");
          live = null;
        }
      }
    }
  });

  document.addEventListener("pointerdown", onPointerDown, true);
  for (const type of ["pointerup", "mousedown", "mouseup", "click", "dblclick"]) document.addEventListener(type, swallow as EventListener, true);
  document.addEventListener("keydown", onKey, true);
  portals.observe(document.body, { childList: true });

  return () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    for (const type of ["pointerup", "mousedown", "mouseup", "click", "dblclick"]) document.removeEventListener(type, swallow as EventListener, true);
    document.removeEventListener("keydown", onKey, true);
    portals.disconnect();
    live?.attrs.disconnect();
    live?.pill.removeAttribute("data-cf-open");
    live = null;
  };
}

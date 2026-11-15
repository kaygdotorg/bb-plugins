/**
 * The desktop chat header's title pill (>= 768px; phones: pills-phone.ts). Read frame/pills.ts first.
 *
 * One glass capsule holds the thread title and bb's ⋯ (Thread actions) as its trailing glyph:
 *   - Click anywhere on it opens bb's own thread actions menu, as a MORPH: the menu starts at the
 *     pill's exact rect and radius and springs to its own, the pill hides while it is open, and
 *     closing runs the same morph backwards into the pill.
 *   - Double click renames the thread inline. bb already renders an inline editor in place of the
 *     title when its menu's "Rename" runs (Enter saves, Escape cancels, blur saves), so we run that
 *     item with the menu invisible (html[data-cf-silent-menu], as swipe.ts does) and only restyle
 *     the editor to sit exactly where the title was.
 *
 * Single vs double click: a single click waits CLICK_WAIT (220ms) before the morph, so a double
 * click can cancel it. 220ms is long enough to catch a deliberate double click, short enough that
 * the press (0.97 scale, instant) still answers at once; opening on the first click and undoing it
 * on the second would flash a menu on every rename. Keyboard (Enter/Space on ⋯) opens at once.
 *
 * The morph (our own implementation of calternal's idea, no code copied): the glass is never
 * scaled or faded (a blur under a moving layer ghosts). The menu is REVEALED with a clip-path that
 * runs from the pill's rect and radius to the menu's own, driven by a spring sampled into a CSS
 * linear() easing. The menu is first moved (the wrapper's `translate`, which composes with Radix's
 * own `transform`) so that its top-left corner is the pill's, and is at least as wide as the pill,
 * so the pill's rect lies inside the menu's. Its items fade in a beat later. Keyboard actions
 * never animate; reduced motion swaps the spring for a short fade.
 *
 * Radix keeps a closing menu mounted only while a CSS animation runs on it, so a `cf-hold`
 * keyframe (no visible change) lasts as long as the reverse morph.
 */
import { R } from "./selectors";
import { GLASS_LAYER, s } from "./pills";

const ROW = `${R} main header [data-testid="app-page-header-content-row"]`;
/** The pill: the row's left cell's only child (bb: title wrapper + the ⋯ span). */
const PILL = `${ROW} > div:first-child > div`;
const PILL_SEL = `main header [data-testid="app-page-header-content-row"] > div:first-child > div`;
const ACTIONS_SEL = `main header button[aria-label="Thread actions"]`;
const EDITOR = "[data-sidebar-rename-editor]";

const CLICK_WAIT = 220;
const wide = () => matchMedia("(min-width: 768px)").matches;
const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

export const TITLE_PILL_CSS = `
@media (min-width: 768px) {
  ${R} {
    --cf-tp-pad: ${s(12)};
    --cf-tp-gap: ${s(6)};
    /* Optical: the ⋯ glyph's dots sit 5/24 inside its icon box, so its box takes that much less padding. */
    --cf-tp-pad-end: calc(var(--cf-tp-pad) - var(--cf-pill-icon) * 5 / 24);
  }

  /* ── The pill: title + ⋯ in one capsule. Words sit on this glass and page text passes under it,
     so the tint is denser than the icon pills' (as the phone capsule's), for >= 4.5:1. */
  ${PILL} {
    position: relative;
    isolation: isolate;
    display: flex;
    align-items: center;
    gap: var(--cf-tp-gap);
    height: var(--cf-pill);
    padding: 0 var(--cf-tp-pad-end) 0 var(--cf-tp-pad);
    border-radius: 999px;
    /* The card's top-left corner is the 62px device radius: 12px more than bb's inset, as the toolbar's right (pills.ts). */
    margin-left: ${s(12)};
    cursor: default;
    user-select: none;
    --cf-pill-alpha: 0.8;
    transition: scale 150ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
  ${R}.dark ${PILL} { --cf-pill-alpha: 0.8; }
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

  /* ⋯ is the trailing glyph: no box of its own, the whole pill is the target. */
  ${PILL} > span { display: flex; flex: none; align-items: center; }
  ${PILL} button[aria-label="Thread actions"] {
    width: var(--cf-pill-icon);
    height: var(--cf-pill-icon);
    min-width: 0;
    padding: 0;
    border-radius: 999px;
    background: transparent !important;
    box-shadow: none !important;
    color: var(--foreground);
  }
  ${PILL} button[aria-label="Thread actions"]:focus-visible { outline: none; box-shadow: none !important; --tw-ring-shadow: 0 0 #0000; }
  ${PILL} button[aria-label="Thread actions"] :is(svg, span.size-4) {
    width: var(--cf-pill-icon);
    height: var(--cf-pill-icon);
  }

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
  ${PILL}[data-cf-open] > * { opacity: 0; transition: opacity 90ms linear; }
  ${PILL}:not([data-cf-open]) > * { transition: opacity 120ms ease-out; }

  /* The menu, mid-morph: bb's own open/close animation steps aside. "prep" is the frame or two
     before it has been placed. */
  ${R} [role="menu"][data-cf-morph] { animation: none !important; }
  ${R} [role="menu"][data-cf-morph="prep"] { visibility: hidden; }
  ${R} [role="menu"][data-cf-morph="on"][data-state="closed"] { animation: cf-hold var(--cf-hold, 260ms) linear both !important; }
  @keyframes cf-hold { from { outline-offset: 0; } to { outline-offset: 0; } }
}
`;

/** A spring (stiffness 520, damping 42, mass 1: calternal's sheet spring family (400/36), a touch quicker) as a CSS linear() easing. */
function spring(): { duration: number; easing: string } {
  const k = 520, c = 42;
  const dt = 1 / 1000;
  let x = 0, v = 0, t = 0, settled = 0;
  const xs: number[] = [0];
  while (t < 2 && settled < 40) {
    v += (-k * (x - 1) - c * v) * dt;
    x += v * dt;
    t += dt;
    xs.push(x);
    settled = Math.abs(x - 1) < 0.002 && Math.abs(v) < 0.02 ? settled + 1 : 0;
  }
  const n = 36;
  const pts = Array.from({ length: n + 1 }, (_, i) => xs[Math.round((i / n) * (xs.length - 1))].toFixed(4));
  pts[n] = "1";
  const easing = CSS.supports("animation-timing-function", "linear(0, 1)")
    ? `linear(${pts.join(", ")})`
    : "cubic-bezier(0.2, 0.9, 0.25, 1)";
  return { duration: Math.round(t * 1000), easing };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const frame = () => new Promise((r) => requestAnimationFrame(r));

export function mountTitlePill(): () => void {
  const root = document.documentElement;
  let timer = 0;
  let armedAt = 0; // when our own click asked for the menu: its opening is a morph
  let live: { wrapper: HTMLElement; menu: HTMLElement; pill: HTMLElement; attrs: MutationObserver } | null = null;
  const motion = spring();

  const pillOf = (el: EventTarget | null) => (el instanceof Element ? (el.closest(PILL_SEL) as HTMLElement | null) : null);
  const actions = () => document.querySelector<HTMLElement>(ACTIONS_SEL);
  const pressActions = () =>
    actions()?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, ctrlKey: false, pointerType: "mouse" }));

  // ── Input: the pointer, never the keyboard, starts a morph.
  const onPointerDown = (e: PointerEvent) => {
    if (!e.isTrusted || e.button !== 0 || !wide()) return;
    const hit = e.target instanceof Element ? e.target.closest(ACTIONS_SEL) : null;
    // bb's ⋯ opens on pointerdown; ours waits to tell a double click apart (see the header comment).
    if (hit && !pillOf(hit)?.querySelector(EDITOR)) e.stopPropagation();
  };
  const onClick = (e: MouseEvent) => {
    if (!e.isTrusted || !wide() || e.detail === 0) return; // detail 0: the keyboard, which Radix handles
    const pill = pillOf(e.target);
    if (!pill || pill.querySelector(EDITOR)) return;
    clearTimeout(timer);
    if (e.detail >= 2) return; // the dblclick handler renames
    timer = window.setTimeout(() => {
      armedAt = performance.now();
      pressActions();
    }, CLICK_WAIT);
  };
  const onDblClick = (e: MouseEvent) => {
    if (!e.isTrusted || !wide()) return;
    const pill = pillOf(e.target);
    if (!pill || pill.querySelector(EDITOR)) return;
    clearTimeout(timer);
    void rename();
  };
  /** Keys that act on the menu must never animate: its morph steps aside. */
  const onKey = (e: KeyboardEvent) => {
    if (live && ["Escape", "Enter", " ", "Tab"].includes(e.key)) live.menu.setAttribute("data-cf-morph", "still");
  };

  /** bb's own Rename item, run with the menu invisible; bb swaps the title for its inline editor. */
  async function rename() {
    const btn = actions();
    if (!btn) return;
    root.setAttribute("data-cf-silent-menu", "");
    try {
      pressActions();
      for (let i = 0; i < 30; i++) {
        const item = [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-labelledby="${btn.id}"] [role="menuitem"]`)].find((el) =>
          /^Rename/.test(el.textContent?.trim() ?? ""),
        );
        if (item) { item.click(); return; }
        await sleep(16);
      }
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); // not found: close it
    } finally {
      setTimeout(() => root.removeAttribute("data-cf-silent-menu"), 200);
    }
  }

  // ── The morph.
  /** The menu mounted: move it over the pill, and open it as a morph if our click asked for it. */
  async function begin(wrapper: HTMLElement, menu: HTMLElement, pill: HTMLElement) {
    const animated = performance.now() - armedAt < 600;
    pill.setAttribute("data-cf-open", "");
    menu.setAttribute("data-cf-morph", "prep");
    menu.style.minWidth = `${pill.getBoundingClientRect().width}px`;
    const attrs = new MutationObserver(() => end(false));
    live = { wrapper, menu, pill, attrs };
    attrs.observe(menu, { attributes: true, attributeFilter: ["data-state"] });

    // Radix places its wrapper a frame or so after mounting (until then: translate(0, -200%)).
    for (let i = 0; i < 12 && /-200%/.test(wrapper.style.transform || "-200%"); i++) await frame();
    if (live?.menu !== menu) return;
    // Top-left corner onto the pill's: `translate` composes with Radix's own transform.
    wrapper.style.translate = "0 0";
    const m = menu.getBoundingClientRect();
    const p = pill.getBoundingClientRect();
    wrapper.style.translate = `${p.left - m.left}px ${p.top - m.top}px`;

    if (!animated) { menu.setAttribute("data-cf-morph", "still"); return; }
    menu.setAttribute("data-cf-morph", "on");
    run(menu, pill, true);
  }

  /** The menu's closing (data-state flipped): reverse the morph if it is still ours and a pointer did it. */
  function end(_unmounted: boolean) {
    if (!live) return;
    const { menu, pill } = live;
    if (menu.getAttribute("data-state") !== "closed" || menu.getAttribute("data-cf-morph") !== "on") return;
    const ms = run(menu, pill, false);
    menu.style.setProperty("--cf-hold", `${ms}ms`);
  }

  /** One direction of the morph; returns its duration. */
  function run(menu: HTMLElement, pill: HTMLElement, opening: boolean): number {
    const kids = [...menu.children] as HTMLElement[];
    if (still()) {
      // Reduced motion: a short fade in place of the spring.
      const ms = opening ? 120 : 90;
      const a = menu.animate({ opacity: opening ? [0, 1] : [1, 0] }, { duration: ms, easing: "linear", fill: "both" });
      if (opening) void a.finished.then(() => a.cancel(), () => {});
      return ms;
    }
    const m = menu.getBoundingClientRect();
    const p = pill.getBoundingClientRect();
    const r0 = p.height / 2;
    const r1 = parseFloat(getComputedStyle(menu).borderTopLeftRadius) || 14;
    const small = `inset(${p.top - m.top}px ${m.right - p.right}px ${m.bottom - p.bottom}px ${p.left - m.left}px round ${r0}px)`;
    const full = `inset(0px round ${r1}px)`;
    const ms = opening ? motion.duration : 260;
    const easing = opening ? motion.easing : "cubic-bezier(0.22, 0.61, 0.36, 1)";
    const clip = menu.animate({ clipPath: opening ? [small, full] : [full, small] }, { duration: ms, easing, fill: "both" });
    const fades = kids.map((k) =>
      k.animate({ opacity: opening ? [0, 1] : [1, 0] }, opening
        ? { duration: 180, delay: 70, easing: "cubic-bezier(0.23, 1, 0.32, 1)", fill: "both" }
        : { duration: 90, easing: "linear", fill: "both" }),
    );
    if (opening) {
      // Done: let go, so the menu's own shadow and edge are never clipped.
      void Promise.all([clip.finished, ...fades.map((f) => f.finished)]).then(() => [clip, ...fades].forEach((a) => a.cancel()), () => {});
    }
    menu.setAttribute("data-cf-morph", "on");
    return ms;
  }

  /** Watches only the body's direct children (portals): a menu of ⋯ arriving, or its wrapper leaving. */
  const portals = new MutationObserver((records) => {
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (!(node instanceof HTMLElement) || !node.hasAttribute("data-radix-popper-content-wrapper")) continue;
        if (root.hasAttribute("data-cf-silent-menu") || !wide()) continue;
        const menu = node.querySelector<HTMLElement>('[role="menu"]');
        const btn = actions();
        const pill = pillOf(btn);
        if (menu && btn && pill && menu.getAttribute("aria-labelledby") === btn.id) void begin(node, menu, pill);
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
  document.addEventListener("click", onClick, true);
  document.addEventListener("dblclick", onDblClick, true);
  document.addEventListener("keydown", onKey, true);
  portals.observe(document.body, { childList: true });

  return () => {
    clearTimeout(timer);
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("dblclick", onDblClick, true);
    document.removeEventListener("keydown", onKey, true);
    portals.disconnect();
    live?.attrs.disconnect();
    live?.pill.removeAttribute("data-cf-open");
    live = null;
  };
}

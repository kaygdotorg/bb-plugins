/**
 * The sidebar's top row (desktop): [wordmark ……] [search] [sidebar toggle]. (+ is the nav's first row, "New thread".)
 *
 * 2026-11-16: + (New thread) and search moved here from the footer (kayg: "the + and search icon
 * belong up there"): one quiet toolbar one gap left of the toggle, always visible; a long wordmark
 * truncates before it. Phones: the same toolbar as glass at the drawer's top-trailing corner.
 *
 * kayg: back/forward are useless there, so they go; the wordmark leads (left), the sidebar
 * toggle trails (right), where the arrows ended. bb's toggle is a fixed overlay at the window's
 * top-left (it must stay reachable when the sidebar is collapsed), so while the sidebar is
 * EXPANDED it is shifted right with `translate` until its right edge meets the top row's content
 * edge (the right edge of every sidebar row); collapsed, it goes back to bb's place. The shift follows the sidebar's real width (bb's
 * --sidebar-width var is stale once you resize), measured with one ResizeObserver.
 *
 * Settings: its row is [toggle][search field]; the arrows go and the field takes their space, the
 * toggle stays leading (no toolbar there: Settings has no top reserve row). Phones: the drawer hides
 * the toggle (pills-phone.ts); the arrows go and the toolbar takes the trailing corner.
 * Motion: the toggle slides when the sidebar opens or closes (transform only, --cf-ease-out),
 * never while you drag the sidebar's edge, and never for the keyboard (input-mode.ts).
 */
import { R } from "./selectors";
import { GLASS_LAYER } from "./pills";
import { activateNavItem, navShortcut, NEW_THREAD, SEARCH_THREADS } from "../ui/nav-actions";

const OVERLAY = '[data-testid="app-sidebar-trigger-overlay"]';
const SIDEBAR = '[data-sidebar="sidebar"]';
const ROW = '[data-testid="app-sidebar-top-reserve-row"]';
/** The sidebar's rows, in order of preference: the plugin's nav, bb's menu rows, bb's group labels. */
const REFS = ['[data-cf-nav] button', '[data-sidebar="content"] [data-sidebar="menu-button"]', '[data-sidebar="group-label"]'];

const CSS = `
/* Back/forward in the sidebar's top rows (main and Settings): gone. */
${R} ${SIDEBAR} div:has(> button[aria-label="Go back"]) { display: none !important; }
${R} ${OVERLAY} { translate: var(--cf-toggle-dx, 0) 0; }
/* + and search (2026-11-16, kayg: "the + and search icon belong up there, in the top row than the footer"):
   one quiet toolbar, one gap left of the toggle, the toggle's centre line:
     [wordmark ……] [+ | search] [toggle]
   The capsule and its segments are the footer's (pills-sidebar.ts styles TOP > div > button as toolbar
   segments: 36 tall, 38px segments, 16px glyphs, quiet fill, the inset highlight, 0.97 press). It never
   shrinks; the wordmark (min-width 0, ellipsis) gives way first, so a long name can't push it off.
   Desktop: the toggle is bb's fixed overlay, not in this row, so the toolbar keeps the toggle's room on
   its right: the toggle (--cf-sb-pill) + one gap + how far the rows' right edge sits inside the row's
   content edge (--cf-sb-col-inset, measured by place(); 0 in headless, ~2.5pt on kayg's browser).
   Collapsed, the toolbar slides away with the sidebar; only the toggle stays. */
${R} ${SIDEBAR} ${ROW} > [data-cf-sb-tools] {
  display: flex;
  align-items: center;
  flex: none;
  margin-left: auto;
  margin-right: calc(var(--cf-sb-col-inset, 0px) + var(--cf-sb-pill, 36px) + var(--cf-ctl-gap, 8px));
  translate: 0 var(--cf-sb-tools-dy, 0px);
}
/* Search alone now: one circle, the toggle's size (36, phones 44) and ink. Every sidebar pill shares one ink
   (kayg, 2026-11-16: "why does the opacity of icons differ?": these were bb's footer look, muted ink with the
   glyph at 80% (L0.78 × 0.8 in dark) next to the toggle's full ink (L0.81)). */
${R} ${SIDEBAR} ${ROW} > [data-cf-sb-tools] { padding: 0 !important; width: var(--cf-sb-pill, 36px); height: var(--cf-sb-pill, 36px) !important; }
${R} [data-cf-sb-tools] > button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  border-radius: 999px;
  appearance: none;
  font: inherit;
  cursor: pointer;
  color: var(--foreground);
  outline: none;
}
${R} [data-cf-sb-tools] > button > svg { flex: none; }
/* The top row's segment sizing (pills-sidebar: every button in the row is a --cf-seg-w wide segment, 48pt on
   phones) also caught this button: wider than its 44pt circle, it put the glyph 2pt right of the circle's centre
   (kayg, 2026-11-16: "search icon is misaligned"). The button is exactly its circle. */
${R} ${SIDEBAR} ${ROW} > [data-cf-sb-tools] > button { width: 100% !important; min-width: 0 !important; height: 100% !important; }
${R} [data-cf-sb-tools] > button:focus-visible { box-shadow: inset 0 0 0 2px var(--sidebar-ring, var(--ring)); }
/* Phones (the drawer has no toggle): the same toolbar at the drawer's top-trailing corner, like Claude's
   and ChatGPT's, as floating glass: 44 tall, two 48pt segments, 20pt glyphs (pills.ts phone tokens), at
   the side inset. It replaced the single search circle (2026-11-16). */
@media (max-width: 767px) {
  ${R} ${SIDEBAR} ${ROW} > [data-cf-sb-tools] {
    position: relative;
    isolation: isolate;
    background: transparent;
    margin-right: 0;
    translate: none;
  }
  /* The row's own end padding becomes the side inset, so the capsule's end sits on it whatever bb's px-2 is. */
  ${R} ${SIDEBAR} ${ROW} { padding-right: var(--cf-ph-side, 20px); }
  ${R} ${SIDEBAR} ${ROW} > [data-cf-sb-tools]::before {
${GLASS_LAYER}}
  ${R} ${SIDEBAR} ${ROW} > [data-cf-sb-tools] { width: var(--cf-pill); height: var(--cf-pill) !important; }
}
/* Slides with the sidebar: bb's own duration and curve for its slide (read at runtime). */
${R} ${OVERLAY}[data-cf-sliding] { transition: translate var(--cf-slide-ms, 200ms) var(--cf-slide-ease, linear); }
`;

/** Writes a custom property only when it changes (a same-value write still queues a mutation record). */
function setVar(el: HTMLElement, name: string, value: string) {
  if (el.style.getPropertyValue(name) !== value) el.style.setProperty(name, value);
}

/** bb's slide for the sidebar: the transition on `left` of its fixed container. */
function slideOf(sidebar: HTMLElement): { ms: number; ease: string } {
  for (let e: HTMLElement | null = sidebar; e && e !== document.body; e = e.parentElement) {
    const cs = getComputedStyle(e);
    if (cs.position !== "fixed") continue;
    const props = cs.transitionProperty.split(",").map((x) => x.trim());
    const i = Math.max(0, props.indexOf("left"));
    const pick = (list: string) => { const xs = list.split(/,(?![^(]*\))/).map((x) => x.trim()); return xs[i % xs.length]; };
    const ms = parseFloat(pick(cs.transitionDuration)) * (pick(cs.transitionDuration).endsWith("ms") ? 1 : 1000);
    return { ms: Number.isFinite(ms) ? ms : 200, ease: pick(cs.transitionTimingFunction) || "linear" };
  }
  return { ms: 200, ease: "linear" };
}

/**
 * The sidebar's content column, relative to the sidebar's left edge (so it holds mid-slide): where
 * its rows' content starts (the first row's icon, else its text) and where the rows end on the
 * right. Measured on the rows themselves, not derived from bb's top row: in some bb builds the
 * rows sit further in than the top row's padding (kayg's screenshot: ~2.5pt both sides).
 * Null on sidebars without bb's top reserve row (Settings).
 */
export function sidebarColumn(sidebar: HTMLElement): { left: number; right: number } | null {
  if (!sidebar.querySelector(ROW)) return null;
  const base = sidebar.getBoundingClientRect().left;
  for (const sel of REFS) {
    for (const el of sidebar.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const icon = el.querySelector("svg")?.getBoundingClientRect();
      const left = icon && icon.width > 0 && icon.left - r.left < 24 ? icon.left : r.left + (parseFloat(getComputedStyle(el).paddingLeft) || 0);
      return { left: left - base, right: r.right - base };
    }
  }
  return null;
}

export function mountSidebarTop(): () => void {
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = CSS;
  document.head.append(style);

  const wide = matchMedia("(min-width: 768px)");
  let lastMode: string | null = null;
  let frame = 0;
  let slidingTimer = 0;
  let alive = true; // a queued frame from an unmounted generation must not touch the DOM (AGENTS.md reload gotcha)

  /**
   * Where the toggle goes. Expanded (desktop, main sidebar): its right edge on the sidebar rows'
   * right edge. Collapsed (desktop): one card gap (+ the card's 1px border) in from bb's spot, since
   * our chat card floats inside the window. Elsewhere (Settings, phones): bb's spot. All three are
   * the one --cf-toggle-dx, so every change between them slides.
   */
  const place = () => {
    frame = 0;
    if (!alive) return;
    const overlay = document.querySelector<HTMLElement>(OVERLAY);
    const toggle = overlay?.querySelector<HTMLElement>("button");
    const sidebar = document.querySelector<HTMLElement>(SIDEBAR);
    if (!overlay || !toggle || !sidebar) return;
    const state = sidebar.closest("[data-state]")?.getAttribute("data-state");
    const collapsed = wide.matches && state === "collapsed";
    document.documentElement.toggleAttribute("data-cf-sb-collapsed", collapsed);
    // The main sidebar only (bb's top reserve row): Settings' row is [toggle][search], already full.
    const col = sidebarColumn(sidebar);
    const expanded = !!col && wide.matches && state === "expanded";
    const mode = expanded ? "expanded" : collapsed ? "collapsed" : "rest";
    // Slide when the sidebar opens or closes (not while its edge is dragged), with the sidebar:
    // bb slides its fixed container's `left`, so copy that transition's duration and curve.
    if (lastMode !== null && mode !== lastMode) {
      const slide = slideOf(sidebar);
      overlay.style.setProperty("--cf-slide-ms", `${slide.ms}ms`);
      overlay.style.setProperty("--cf-slide-ease", slide.ease);
      overlay.setAttribute("data-cf-sliding", "");
      window.clearTimeout(slidingTimer);
      slidingTimer = window.setTimeout(() => overlay.removeAttribute("data-cf-sliding"), slide.ms + 60);
    }
    lastMode = mode;
    placeToolsBox(sidebar, toggle, col, mode === "expanded");
    if (mode === "collapsed") { overlay.style.setProperty("--cf-toggle-dx", "calc(var(--cf-gap) + 1px)"); return; }
    if (mode !== "expanded" || !col) { overlay.style.setProperty("--cf-toggle-dx", "0px"); return; }
    // From the RESTING layout, not the on-screen box: bb's sidebar is off-canvas and slides in by
    // `left`, so at the moment it opens it is still off screen. At rest it starts at the window's
    // left edge (+ the safe area: the overlay's own left); col.right is relative to the sidebar.
    const restLeft = parseFloat(getComputedStyle(overlay).left) || 0;
    // The toggle's right edge without our shift. Mid-slide the shift on screen is the transition's
    // current value (the computed translate), not the target in --cf-toggle-dx.
    const current = toggle.getBoundingClientRect().right - (parseFloat(getComputedStyle(overlay).translate) || 0);
    overlay.style.setProperty("--cf-toggle-dx", `${(restLeft + col.right - current).toFixed(2)}px`);
  };
  /**
   * The top toolbar's box on desktop: its right end one gap before where the toggle comes to rest
   * (the rows' right edge, which can sit inside the row's content edge: --cf-sb-col-inset), and its
   * centre on the toggle's centre line (--cf-sb-tools-dy; 0 when the row and the overlay share it, as
   * in bb 0.49). Written on the row/toolbar, never on <html>, and only when changed.
   */
  const placeToolsBox = (sidebar: HTMLElement, toggle: HTMLElement, col: { right: number } | null, expanded: boolean) => {
    const row = tools.parentElement;
    if (!row) return;
    let inset = 0, dy = 0;
    if (expanded && col) {
      const rr = row.getBoundingClientRect();
      const padR = parseFloat(getComputedStyle(row).paddingRight) || 0;
      inset = Math.max(0, rr.right - padR - sidebar.getBoundingClientRect().left - col.right);
      const t = toggle.getBoundingClientRect();
      const b = tools.getBoundingClientRect();
      const dyNow = parseFloat(tools.style.getPropertyValue("--cf-sb-tools-dy")) || 0;
      dy = t.top + t.height / 2 - (b.top - dyNow + b.height / 2);
    }
    setVar(row, "--cf-sb-col-inset", `${inset.toFixed(2)}px`);
    setVar(tools, "--cf-sb-tools-dy", `${dy.toFixed(2)}px`);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };

  const resize = new ResizeObserver(schedule);
  // A state flip places the toggle at once (a microtask, before the next style pass), so the slide
  // starts in the same frame as bb's; a rAF later would let the old position render one frame.
  const states = new MutationObserver(() => { cancelAnimationFrame(frame); place(); });
  let observed: Element | null = null;
  let overlaySeen: Element | null = null;
  let page = "";
  /** The 1s check costs no layout: it re-places only when bb swapped an element or the page changed
   *  (Settings has no top row). Everything else is event-driven (state flips, resizes). */
  // + and search (see the CSS): one toolbar element, put back whenever bb re-renders the top row. Its
  // buttons run bb's own nav actions (ui/nav-actions.ts, published by the plugin's navigation), the
  // same as the footer items they replace (2026-11-16). Glyphs are bb's own Plus and Search (stroke 1.5),
  // copied from the footer items so the two rows match. DOM order (in the sidebar, which precedes bb's
  // toggle overlay) gives the Tab order + → search → toggle.
  const tools = document.createElement("div");
  tools.setAttribute("data-cf-sb-tools", "");
  tools.setAttribute("role", "group");
  tools.setAttribute("aria-label", "Threads");
  const tool = (id: string, label: string, paths: string) => {
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("data-cf-sb-tool", id);
    b.setAttribute("aria-label", label);
    b.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
    b.addEventListener("click", () => activateNavItem(id === "new" ? NEW_THREAD : SEARCH_THREADS));
    tools.append(b);
    return b;
  };
  // + went to the nav as its first row, "New thread" (kayg, 2026-11-16: "replace Threads with a New Thread
  // with a + icon on the left and get rid of the + icon at the top"), so the top row keeps search alone.
  const searchBtn = tool("search", "Search threads", '<path d="M17 17L21 21"/><path d="M19 11C19 6.58 15.42 3 11 3C6.58 3 3 6.58 3 11C3 15.42 6.58 19 11 19C15.42 19 19 15.42 19 11Z"/>');
  /** bb's shortcut for each (as aria-keyshortcuts: the warm tooltip shows it as a chip), once the nav has published it. */
  const keys = (b: HTMLElement, id: string) => {
    const k = navShortcut(id);
    if (k && b.getAttribute("aria-keyshortcuts") !== k) b.setAttribute("aria-keyshortcuts", k);
    else if (!k && b.hasAttribute("aria-keyshortcuts")) b.removeAttribute("aria-keyshortcuts");
  };
  const placeTools = () => {
    const row = document.querySelector(`${SIDEBAR} ${ROW}`);
    if (row && tools.parentElement !== row) { row.append(tools); schedule(); }
    keys(searchBtn, SEARCH_THREADS);
  };
  const attach = () => {
    placeTools();
    const sidebar = document.querySelector(SIDEBAR);
    const overlay = document.querySelector(OVERLAY);
    let changed = overlay !== overlaySeen || location.pathname !== page;
    overlaySeen = overlay; page = location.pathname;
    if (sidebar && sidebar !== observed) {
      resize.disconnect(); states.disconnect();
      resize.observe(sidebar);
      const stateful = sidebar.closest("[data-state]");
      if (stateful) states.observe(stateful, { attributes: true, attributeFilter: ["data-state"] });
      observed = sidebar;
      changed = true;
    }
    // Load race (found 2026-11-16): the first place() can run before bb has laid out the rows
    // (no column → "rest"), and nothing re-places afterwards (the off-canvas sidebar never resizes, its
    // state doesn't flip), so on a fresh load the toggle stayed at the window's top-left, over the
    // wordmark. Retry while an expanded desktop sidebar is still placed as "rest".
    if (!changed && lastMode === "rest" && wide.matches && sidebar?.closest("[data-state]")?.getAttribute("data-state") === "expanded" && sidebar.querySelector(ROW)) changed = true;
    if (changed) schedule();
  };
  attach();
  const timer = window.setInterval(attach, 1000); // bb re-renders the shell on navigation
  wide.addEventListener("change", schedule);
  window.addEventListener("resize", schedule, { passive: true });
  return () => {
    window.clearInterval(timer);
    cancelAnimationFrame(frame);
    resize.disconnect(); states.disconnect();
    wide.removeEventListener("change", schedule);
    window.removeEventListener("resize", schedule);
    document.querySelector<HTMLElement>(OVERLAY)?.style.removeProperty("--cf-toggle-dx");
    document.documentElement.removeAttribute("data-cf-sb-collapsed");
    tools.parentElement?.style.removeProperty("--cf-sb-col-inset");
    tools.remove();
    alive = false;
    style.remove();
  };
}

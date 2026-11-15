/**
 * The sidebar's top row (desktop): [wordmark] ············ [sidebar toggle].
 *
 * kayg: back/forward are useless there, so they go; the wordmark leads (left), the sidebar
 * toggle trails (right), where the arrows ended. bb's toggle is a fixed overlay at the window's
 * top-left (it must stay reachable when the sidebar is collapsed), so while the sidebar is
 * EXPANDED it is shifted right with `translate` until its right edge meets the top row's content
 * edge (the right edge of every sidebar row); collapsed, it goes back to bb's place. The shift follows the sidebar's real width (bb's
 * --sidebar-width var is stale once you resize), measured with one ResizeObserver.
 *
 * Settings: its row is [toggle][search field]; the arrows go and the field takes their space, the
 * toggle stays leading. Phones: the drawer hides the toggle (pills-phone.ts); only the arrows go.
 * Motion: the toggle slides when the sidebar opens or closes (transform only, --cf-ease-out),
 * never while you drag the sidebar's edge, and never for the keyboard (input-mode.ts).
 */
import { R } from "./selectors";
import { GLASS_LAYER, s } from "./pills";

const OVERLAY = '[data-testid="app-sidebar-trigger-overlay"]';
const SIDEBAR = '[data-sidebar="sidebar"]';
const ROW = '[data-testid="app-sidebar-top-reserve-row"]';
/** The sidebar's rows, in order of preference: the plugin's nav, bb's menu rows, bb's group labels. */
const REFS = ['[data-cf-nav] button', '[data-sidebar="content"] [data-sidebar="menu-button"]', '[data-sidebar="group-label"]'];

const CSS = `
/* Back/forward in the sidebar's top rows (main and Settings): gone. */
${R} ${SIDEBAR} div:has(> button[aria-label="Go back"]) { display: none !important; }
${R} ${OVERLAY} { translate: var(--cf-toggle-dx, 0) 0; }
/* Slides with the sidebar: bb's own duration and curve for its slide (read at runtime). */
/* Phones: a search button at the drawer's top-trailing corner, like Claude's and ChatGPT's (a 44pt glass
   circle at the side inset); the footer's own search button steps aside there. Desktop keeps the footer's. */
${R} [data-cf-sb-search] { display: none; }
@media (max-width: 767px) {
  ${R} [data-cf-sb-search] {
    display: inline-flex;
    position: relative;
    isolation: isolate;
    align-items: center;
    justify-content: center;
    flex: none;
    width: var(--cf-pill);
    height: var(--cf-pill);
    margin-left: auto;
    margin-right: calc(var(--cf-ph-side, 20px) - 0.55rem); /* the row's own padding is 0.55rem (8.8px) */
    padding: 0;
    border: 0;
    border-radius: 999px;
    background: transparent;
    color: var(--foreground);
    transition: scale 150ms var(--cf-ease-out);
  }
  ${R} [data-cf-sb-search]::before {
${GLASS_LAYER}}
  ${R} [data-cf-sb-search]:active { scale: 0.97; }
  ${R} [data-cf-sb-search] svg { width: var(--cf-pill-icon); height: var(--cf-pill-icon); }
  ${R} ${SIDEBAR} [data-sidebar="footer"] li[data-footer-item]:has(> button[aria-label^="Search threads"]) { display: none !important; }
}
${R} ${OVERLAY}[data-cf-sliding] { transition: translate var(--cf-slide-ms, 200ms) var(--cf-slide-ease, linear); }
`;

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

  /**
   * Where the toggle goes. Expanded (desktop, main sidebar): its right edge on the sidebar rows'
   * right edge. Collapsed (desktop): one card gap (+ the card's 1px border) in from bb's spot, since
   * our chat card floats inside the window. Elsewhere (Settings, phones): bb's spot. All three are
   * the one --cf-toggle-dx, so every change between them slides.
   */
  const place = () => {
    frame = 0;
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
  // The phone search button (see the CSS): one element, put back whenever bb re-renders the top row.
  const search = document.createElement("button");
  search.type = "button";
  search.setAttribute("data-cf-sb-search", "");
  search.setAttribute("aria-label", "Search threads");
  search.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  search.addEventListener("click", () => {
    [...document.querySelectorAll<HTMLButtonElement>("button[aria-label]")]
      .find((b) => b !== search && /^Search threads/i.test(b.getAttribute("aria-label") ?? ""))?.click();
  });
  const placeSearch = () => {
    const row = document.querySelector(`${SIDEBAR} ${ROW}`);
    if (row && search.parentElement !== row) row.append(search);
  };
  const attach = () => {
    placeSearch();
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
    search.remove();
    style.remove();
  };
}

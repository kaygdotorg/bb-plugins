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

const OVERLAY = '[data-testid="app-sidebar-trigger-overlay"]';
const SIDEBAR = '[data-sidebar="sidebar"]';
const ROW = '[data-testid="app-sidebar-top-reserve-row"]';

const CSS = `
/* Back/forward in the sidebar's top rows (main and Settings): gone. */
${R} ${SIDEBAR} div:has(> button[aria-label="Go back"]) { display: none !important; }
${R} ${OVERLAY} { translate: var(--cf-toggle-dx, 0) 0; }
/* Slides with the sidebar: bb's own duration and curve for its slide (read at runtime). */
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

export function mountSidebarTop(): () => void {
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = CSS;
  document.head.append(style);

  const wide = matchMedia("(min-width: 768px)");
  let lastExpanded: boolean | null = null;
  let frame = 0;
  let slidingTimer = 0;

  /** Expanded sidebar on desktop: the toggle's right edge on the top row's content edge. */
  const place = () => {
    frame = 0;
    const overlay = document.querySelector<HTMLElement>(OVERLAY);
    const toggle = overlay?.querySelector<HTMLElement>("button");
    const sidebar = document.querySelector<HTMLElement>(SIDEBAR);
    if (!overlay || !toggle || !sidebar) return;
    // The main sidebar only (bb's top reserve row): Settings' row is [toggle][search], already full.
    const row = sidebar.querySelector<HTMLElement>(ROW);
    const box = row?.getBoundingClientRect();
    const expanded = !!box && box.width > 0 && wide.matches && sidebar.closest("[data-state]")?.getAttribute("data-state") === "expanded";
    // Slide only when the sidebar opens or closes, not while its edge is dragged, and with the
    // sidebar: bb slides its fixed container's `left`, so copy that transition's duration and curve.
    if (lastExpanded !== null && expanded !== lastExpanded) {
      const slide = slideOf(sidebar);
      overlay.style.setProperty("--cf-slide-ms", `${slide.ms}ms`);
      overlay.style.setProperty("--cf-slide-ease", slide.ease);
      overlay.setAttribute("data-cf-sliding", "");
      window.clearTimeout(slidingTimer);
      slidingTimer = window.setTimeout(() => overlay.removeAttribute("data-cf-sliding"), slide.ms + 60);
    }
    lastExpanded = expanded;
    if (!expanded || !row || !box) { overlay.style.setProperty("--cf-toggle-dx", "0px"); return; }
    // The row's content edge (its 8.8px padding in), which is also every sidebar row's right edge.
    // From the RESTING layout, not the on-screen box: bb's sidebar is off-canvas and slides in by
    // `left`, so at the moment it opens it is still off screen (its box would put the toggle at x<0).
    // At rest the sidebar starts at the window's left edge (+ the safe area, the overlay's own left).
    const restLeft = parseFloat(getComputedStyle(overlay).left) || 0;
    const inset = box.left - sidebar.getBoundingClientRect().left; // the row inside the sidebar (both slide together)
    const rowRight = restLeft + inset + box.width - (parseFloat(getComputedStyle(row).paddingRight) || 0);
    // The toggle's right edge without our shift. Mid-slide the shift on screen is the transition's
    // current value (the computed translate), not the target in --cf-toggle-dx.
    const current = toggle.getBoundingClientRect().right - (parseFloat(getComputedStyle(overlay).translate) || 0);
    overlay.style.setProperty("--cf-toggle-dx", `${(rowRight - current).toFixed(2)}px`);
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(place); };

  const resize = new ResizeObserver(schedule);
  const states = new MutationObserver(schedule);
  let observed: Element | null = null;
  const attach = () => {
    const sidebar = document.querySelector(SIDEBAR);
    if (sidebar && sidebar !== observed) {
      resize.disconnect(); states.disconnect();
      resize.observe(sidebar);
      const stateful = sidebar.closest("[data-state]");
      if (stateful) states.observe(stateful, { attributes: true, attributeFilter: ["data-state"] });
      observed = sidebar;
    }
    schedule();
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
    style.remove();
  };
}

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
${R} ${OVERLAY}[data-cf-sliding] { transition: translate 220ms var(--cf-ease-out); }
`;

export function mountSidebarTop(): () => void {
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = CSS;
  document.head.append(style);

  const wide = matchMedia("(min-width: 768px)");
  let lastExpanded: boolean | null = null;
  let frame = 0;

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
    // Slide only when the sidebar opens or closes, not while its edge is dragged.
    if (lastExpanded !== null && expanded !== lastExpanded) {
      overlay.setAttribute("data-cf-sliding", "");
      window.setTimeout(() => overlay.removeAttribute("data-cf-sliding"), 260);
    }
    lastExpanded = expanded;
    if (!expanded || !row || !box) { overlay.style.setProperty("--cf-toggle-dx", "0px"); return; }
    // The row's content edge (its 8.8px padding in), which is also every sidebar row's right edge.
    const rowRight = box.right - (parseFloat(getComputedStyle(row).paddingRight) || 0);
    const current = toggle.getBoundingClientRect().right - (parseFloat(overlay.style.getPropertyValue("--cf-toggle-dx")) || 0);
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

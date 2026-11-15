/**
 * The usage pill (cliproxy-usage's overlay in the sidebar footer) when the sidebar is too narrow
 * for every provider: it shows ONE provider instead of clipping ("1%  83" with the % cut off).
 *
 * Which one: the provider of the chat you are in (read from the composer's provider logo, whose URL
 * names bb's provider: claude-code → claude, codex → codex); with no chat open (Settings, a new
 * page), the one closest to its limit (cliproxy-usage's data-cliproxy-primary).
 *
 * Fit: the room is from the pill's left edge to the toolbar capsule's left edge minus one control
 * gap; the full pill's natural width comes from its entries' own widths, so widening the sidebar
 * brings every provider back as soon as they fit. Measured when the footer resizes (ResizeObserver)
 * and on a light 1s check (a new chat, new numbers): no per-frame work.
 *
 * Mark: [data-cf-usage-compact] on the pill; [data-cf-usage-keep] on the provider it keeps, always,
 * so the toolbar's hover collapse (pills-sidebar.ts) keeps the same one.
 */
import { R } from "./selectors";

const FOOT = '[data-sidebar="sidebar"] [data-sidebar="footer"]';
const PILL = `${FOOT} [data-cliproxy-footer]`;
/** The toolbar's members (pills-sidebar.ts TB_MEMBER); the capsule starts one pad before the leftmost
 *  (by position: CSS `order` puts Settings last, so DOM order is not the visual one). */
const TOOLBAR = `${FOOT} li[data-footer-item]:not([data-footer-item^="plugin:cliproxy-usage/"]) > :is(button, a)`;
const LOGO = "[data-app-composer] [data-provider-logo]";

const CSS = `
${R} [data-cliproxy-footer][data-cf-usage-compact] { gap: 0; }
${R} [data-cliproxy-footer][data-cf-usage-compact] > span:not([data-cf-usage-keep]) {
  max-width: 0 !important;
  opacity: 0;
  overflow: hidden;
}
`;

/** bb provider id (logo URL) → cliproxy-usage provider id. */
function chatProvider(): string | null {
  const url = document.querySelector(LOGO)?.getAttribute("data-provider-logo") ?? "";
  if (url.includes("/providers/claude-code/")) return "claude";
  if (url.includes("/providers/codex/")) return "codex";
  return null;
}

export function mountFooterUsage(): () => void {
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = CSS;
  document.head.append(style);

  let frame = 0;

  const update = () => {
    frame = 0;
    const pill = document.querySelector<HTMLElement>(PILL);
    const members = [...document.querySelectorAll<HTMLElement>(TOOLBAR)];
    const first = members.length ? members.reduce((a, b) => (b.getBoundingClientRect().left < a.getBoundingClientRect().left ? b : a)) : null;
    if (!pill || !first) return;
    const spans = [...pill.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c.hasAttribute("data-cliproxy-provider"));
    if (spans.length < 2) { pill.removeAttribute("data-cf-usage-compact"); spans.forEach((s) => s.removeAttribute("data-cf-usage-keep")); return; }
    const cs = getComputedStyle(document.documentElement);
    const capsule = first.parentElement?.parentElement;
    const pad = capsule ? parseFloat(getComputedStyle(capsule).getPropertyValue("--cf-sb-pad")) || 3 : 3;
    const gap = parseFloat(cs.getPropertyValue("--cf-ctl-gap")) || 8;
    const room = first.getBoundingClientRect().left - pad - gap - pill.getBoundingClientRect().left;
    // The full pill's natural width, from the entries' own widths (scrollWidth ignores the
    // max-width a collapse puts on them): padding + entries + the 11px gaps between them.
    const pcs = getComputedStyle(pill);
    const scale = parseFloat(cs.getPropertyValue("--cf-ui-scale")) || 1;
    const full = (parseFloat(pcs.paddingLeft) || 0) + (parseFloat(pcs.paddingRight) || 0)
      + spans.reduce((w, s) => w + s.scrollWidth, 0) + 11 * scale * (spans.length - 1);
    pill.toggleAttribute("data-cf-usage-compact", full > room + 0.5);
    mark(spans);
  };
  /** The kept provider: this chat's, else the one nearest its limit, else the first. */
  const mark = (spans: HTMLElement[]) => {
    const want = chatProvider();
    const keep = spans.find((s) => s.dataset.cliproxyProvider === want)
      ?? spans.find((s) => s.hasAttribute("data-cliproxy-primary")) ?? spans[0];
    spans.forEach((s) => s.toggleAttribute("data-cf-usage-keep", s === keep));
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };

  const resize = new ResizeObserver(schedule);
  let watched: Element | null = null;
  let seen = "";
  /** The 1s check costs no layout: it measures only when something it depends on changed: the
   *  footer element, the chat's provider, or the usage text (new numbers change the widths). */
  const attach = () => {
    const foot = document.querySelector(FOOT);
    let changed = false;
    if (foot && foot !== watched) { resize.disconnect(); resize.observe(foot); watched = foot; changed = true; }
    const sig = `${chatProvider()}|${document.querySelector(PILL)?.textContent ?? ""}`;
    if (sig !== seen) { seen = sig; changed = true; }
    if (changed) schedule();
  };
  attach();
  const timer = window.setInterval(attach, 1000);
  return () => {
    window.clearInterval(timer);
    cancelAnimationFrame(frame);
    resize.disconnect();
    document.querySelectorAll("[data-cf-usage-compact]").forEach((e) => e.removeAttribute("data-cf-usage-compact"));
    document.querySelectorAll("[data-cf-usage-keep]").forEach((e) => e.removeAttribute("data-cf-usage-keep"));
    style.remove();
  };
}

/**
 * Sidebar pills: the sidebar's top controls and footer row. Part of the pill UI: read frame/pills.ts first (tokens, GLASS_LAYER, rules).
 *
 * The sidebar sits flat on the backdrop, so every pill and toolbar here is the quiet tint
 * (--cf-pill-quiet), never glass.
 *
 *   - Top row: the sidebar toggle is a pill of its own (bb's fixed overlay, expanded and collapsed:
 *     the collapsed shift in css.ts is a translate on the overlay, untouched). Back/forward are one toolbar.
 *   - Footer: bb's row is `ul > li(flex-1) > ul > li[data-footer-item] …`. That inner ul stays
 *     full width (bb measures it); its ::before is the toolbar capsule (+, search, settings, "…"),
 *     anchored from the first toolbar item to the right edge, so it grows with the "…" on hover.
 *     The usage item keeps its li at the left; cliproxy-usage's overlay on it is the separate usage pill.
 *   - bb measures footer item widths to decide what overflows: every li stays one width (the
 *     toolbar segment's), and the gap is the toolbar's gap, which bb reads from the row.
 *   - Sizes are pills.ts's shared tokens: desktop 36px controls, 38px segments, 16px icons; phones
 *     44px, 48px segments, 20px glyphs; 8px between groups on both.
 */
import { R } from "./selectors";
import { GLASS_LAYER, SEGMENT, s } from "./pills";

void GLASS_LAYER;

const FOOT = `${R} [data-sidebar="footer"]`;
const TOP = `${R} [data-sidebar="sidebar"] [data-testid="app-sidebar-top-reserve-row"]`;
const TOGGLE = `${R} [data-testid="app-sidebar-trigger-overlay"] [data-sidebar="trigger"]`;
const ITEM = `${FOOT} [data-sidebar="menu"] [data-sidebar="menu"] > li[data-sidebar="menu-item"]`;
const MORE = `${ITEM}:not([data-footer-item])`;
const ROW = `${FOOT} [data-sidebar="menu"] [data-sidebar="menu"]`;
const TB_MEMBER = `li[data-footer-item]:not([data-footer-item^="plugin:cliproxy-usage/"])`;
/** The reveal triggers on the toolbar only (hover, keyboard focus, or its "…" menu open), never on the usage pill. */
const TB_ACTIVE = `:is(:has(> ${TB_MEMBER}:hover), :has(> ${TB_MEMBER} :focus-visible), :has(> li:not([data-footer-item]):hover), :has(> li:not([data-footer-item]) :is(:focus-visible, [data-state="open"])))`;
const MORE_SHOWN = `${ROW}${TB_ACTIVE} > li[data-sidebar="menu-item"]:not([data-footer-item])`;
const TB_BTN = `:is(${TOP} > div > button, ${ITEM} > :is(button, a))`;
const ALL_BTN = `:is(${TOP} > div > button, ${TOGGLE}, ${ITEM} > :is(button, a))`;

export const PILL_SIDEBAR_CSS = `
${R} {
  --cf-sb-tb: var(--cf-tb);
  --cf-sb-in: var(--cf-tb-pill);   /* a segment's height */
  --cf-sb-seg: var(--cf-seg-w);    /* and width */
  --cf-sb-pill: var(--cf-pill);
  --cf-sb-icon: var(--cf-pill-icon);
  --cf-sb-hy: 0px; /* segments fill their capsule, so no hit-area extension is needed */
  --cf-sb-hx: 0px;
  --cf-sb-pad: var(--cf-tb-pad);
  --cf-sb-gap: var(--cf-tb-gap);
  --cf-sb-iy: var(--cf-seg-iy);
  --cf-sb-ix: var(--cf-seg-ix);
}

/* ── The sidebar toggle: a pill of its own. */
${TOGGLE} {
  position: relative;
  width: var(--cf-sb-pill);
  height: var(--cf-sb-pill);
  min-width: var(--cf-sb-pill);
  padding: 0;
  border-radius: 999px;
  background: var(--cf-pill-quiet);
  color: var(--foreground);
}

/* ── Top row: back/forward as one toolbar (segments of one capsule). */
${TOP} > div:has(> button) {
  height: var(--cf-sb-tb);
  padding: var(--cf-sb-pad);
  gap: var(--cf-sb-gap);
  border-radius: 999px;
  background: var(--cf-pill-quiet);
  box-sizing: border-box;
}

/* ── Footer: the inner row stays bb's full-width row (bb measures it), laid out with the toolbar
   items at its right end. The capsule is the row's ::before, anchored (CSS anchor positioning)
   from the first toolbar item to the row's right edge, so it grows when the "…" does. */
${FOOT} [data-sidebar="menu"] [data-sidebar="menu"] {
  position: relative;
  isolation: isolate;
  align-items: center;
  height: var(--cf-sb-tb);
  padding-block: var(--cf-sb-pad);
  padding-inline: 0 var(--cf-sb-pad);
  gap: var(--cf-sb-gap);
}
${FOOT} [data-sidebar="menu"] [data-sidebar="menu"]::before {
  content: "";
  position: absolute;
  z-index: -1;
  position-anchor: --cf-sb-start;
  top: 0;
  bottom: 0;
  right: 0;
  left: calc(anchor(left, 100%) - var(--cf-sb-pad));
  border-radius: 999px;
  background: var(--cf-pill-quiet);
  pointer-events: none;
}
${ITEM}[data-footer-item="plugin:calternal-ui/new-thread"] { anchor-name: --cf-sb-start; }
${ITEM} {
  width: var(--cf-sb-seg);
  min-width: var(--cf-sb-seg);
  height: var(--cf-sb-in);
}
/* The usage item stays first in the row; its overlay is the separate pill, as tall as the toolbar. */
${ITEM}[data-footer-item^="plugin:cliproxy-usage/"] {
  height: var(--cf-sb-tb);
  display: flex;
  align-items: center;
  position: static; /* the overlay is placed against the row, where the toolbar's anchor is in reach */
}
${ITEM}[data-footer-item^="plugin:cliproxy-usage/"] > button { height: var(--cf-sb-in); }
${FOOT} [data-cliproxy-footer] {
  height: var(--cf-sb-tb);
  /* From the row's left to the toolbar's left edge (anchored, so it follows the toolbar as it
     grows), never wider than its content. Replaces cliproxy-usage's own room estimate. */
  position-anchor: --cf-sb-start;
  left: ${s(3)}; /* the row starts 3px left of the toggle pill: this lines the two up */
  right: calc(anchor(left, 0px) + var(--cf-sb-pad) + var(--cf-ctl-gap));
  width: auto;
  max-width: max-content;
  padding-inline: var(--cf-text-pad);
  gap: ${s(11)};
  border-radius: 999px;
  background: var(--cf-pill-quiet);
  box-sizing: border-box;
  transition: scale 150ms var(--cf-ease-out), background-color 150ms ease, gap 220ms var(--cf-ease-out);
}
${FOOT} [data-cliproxy-footer] > span {
  max-width: ${s(88)};
  transition: max-width 220ms var(--cf-ease-out), opacity 180ms ease;
}
/* Where the browser can animate from max-content, the entry shrinks by exactly its own width in
   step with the toolbar's growth (else the 88px start would idle for most of the 220ms). */
@supports (interpolate-size: allow-keywords) {
  ${FOOT} [data-cliproxy-footer] > span { interpolate-size: allow-keywords; max-width: max-content; }
}
/* The pill's tint lightens (dark) or darkens (light) the wallpaper under the text, which can be a bright patch: ink the text a step
   stronger than cliproxy-usage's own so it holds 4.5:1 on it (measured in light and dark). */
${FOOT} [data-cliproxy-footer] > span:not([data-cliproxy-tone]) { color: oklch(0.34 0 0); }
${FOOT} [data-cliproxy-footer] > [data-cliproxy-tone="warn"] { color: oklch(0.36 0.12 45); }
${R}.dark ${FOOT.replace(R + ' ', '')} [data-cliproxy-footer] > span:not([data-cliproxy-tone]) { color: oklch(0.93 0 0); }
${R}.dark ${FOOT.replace(R + ' ', '')} [data-cliproxy-footer] > [data-cliproxy-tone="warn"] { color: oklch(0.92 0.09 80); }
${FOOT} [data-cliproxy-footer]:hover { background: var(--cf-pill-hover); }
${FOOT} [data-cliproxy-footer]:active { scale: 0.97; }

/* ── Every toolbar item: a segment (pills.ts SEGMENT), one icon size, centred, the highlight, the press. */
${TB_BTN} {
${SEGMENT}  --cf-seg-w: var(--cf-sb-seg);
  --cf-tb-pill: var(--cf-sb-in);
  --cf-seg-iy: var(--cf-sb-iy);
  --cf-seg-ix: var(--cf-sb-ix);
  position: relative;
  background-color: transparent;
  overflow: visible; /* bb clips its buttons; the hit-area extension below must not be */
}
${TB_BTN}::after {
  content: "";
  position: absolute;
  inset: calc(-1 * var(--cf-sb-hy)) calc(-1 * var(--cf-sb-hx));
}
${ITEM}[data-footer-item="plugin:calternal-ui/new-thread"] > button::after { left: calc(-1 * var(--cf-sb-pad)); }
${ITEM}[data-footer-item="builtin:settings"] > :is(button, a)::after, ${ITEM}:not([data-footer-item]) > button::after { right: calc(-1 * var(--cf-sb-pad)); }
${ALL_BTN} {
  transition: scale 150ms var(--cf-ease-out), background-color 150ms ease, color 150ms ease;
}
${ALL_BTN} :is(svg, span.size-4) {
  width: var(--cf-sb-icon);
  height: var(--cf-sb-icon);
}
@media (hover: hover) {
  ${ALL_BTN}:not([aria-disabled="true"]):hover { background-color: var(--cf-pill-hover); }
}
${ALL_BTN}:not([aria-disabled="true"]):active { scale: 0.97; background-color: var(--cf-pill-hover); }
@media (prefers-reduced-motion: reduce) { ${ALL_BTN} { transition: none; } }

/* The "…" reveal (css.ts "Quiet sidebar"): same slide, at the toolbar's pill width and gap, so
   the capsule grows with it. The selectors are one step stronger than css.ts's, and retarget the trigger from the whole footer
row to the toolbar alone (so the usage pill stays clickable under the pointer). */
@media (hover: hover) {
  ${MORE} {
    width: 0;
    min-width: 0 !important;
    margin-inline-start: calc(-1 * var(--cf-sb-gap));
    opacity: 0;
    translate: -0.375rem 0;
  }
  ${MORE_SHOWN} {
    width: var(--cf-sb-seg);
    min-width: var(--cf-sb-seg) !important;
    margin-inline-start: 0;
    opacity: 1;
    translate: 0 0;
  }
}

/* While "…" slides in and the toolbar grows to four pills, the usage pill gives way: it keeps one
   provider (this chat's, else the one closest to its limit: footer-usage.ts marks it data-cf-usage-keep) and the others collapse with the
   same timing, so the two never overlap at any frame. */
@media (hover: hover) {
  ${ROW}${TB_ACTIVE} [data-cliproxy-footer] { gap: 0; }
  ${ROW}${TB_ACTIVE} [data-cliproxy-footer] > span:not([data-cf-usage-keep]) {
    max-width: 0;
    opacity: 0;
    overflow: hidden;
  }
}
@media (prefers-reduced-motion: reduce) {
  ${FOOT} [data-cliproxy-footer], ${FOOT} [data-cliproxy-footer] > span { transition: none; }
}

/* ── Browsers without CSS anchor positioning (Safari before 26): the anchored capsule and the
   usage pill's anchored right edge would fall back to zero width / the full row, so the usage
   pill would cover the toolbar. Here the capsule is sized from the item count instead (four
   items on touch, where "…" always shows; three with a mouse, where "…" only slides in on
   hover), and the usage pill is capped to the space left of it. */
@supports not (anchor-name: --cf-a) {
  ${FOOT} {
    --cf-sb-n: 3;
  }
  @media (hover: none) {
    ${FOOT} { --cf-sb-n: 4; }
  }
  ${FOOT} [data-sidebar="menu"] [data-sidebar="menu"]::before {
    left: auto;
    width: calc(var(--cf-sb-n) * var(--cf-sb-seg) + (var(--cf-sb-n) - 1) * var(--cf-sb-gap) + 2 * var(--cf-sb-pad));
  }
  ${FOOT} [data-cliproxy-footer] {
    right: auto;
    max-width: calc(100% - var(--cf-sb-n) * var(--cf-sb-seg) - (var(--cf-sb-n) - 1) * var(--cf-sb-gap) - 2 * var(--cf-sb-pad) - var(--cf-ctl-gap));
  }
}

/* Phones: the drawer's footer keeps the same 20px side inset as its top row (the wordmark's ink
   starts at 20; iOS 27 uses 20pt). bb pads the footer 8px; the usage pill and the toolbar's end
   then sat 10px and 8px from the edges. */
@media (max-width: 767px) {
  ${R} [data-sidebar="sidebar"] [data-sidebar="footer"] {
    padding-left: var(--cf-ph-side, 20px) !important; /* the usage pill starts on the side inset (it has no offset of its own: it sat 3pt short, at 17 of 20) */
    padding-right: var(--cf-ph-side, 20px) !important;
  }
}
`;

/**
 * The pill UI, after calternal's (packages/ui: Pill, Toolbar, Glass; TASTE.md). Read-only
 * reference: values and rules are taken over, the code is our own CSS over bb's buttons.
 *
 *   - A pill is a round button: 0.97 press, 9% ink hover tint, the warm tooltip, one icon size.
 *   - Separate actions are separate pills. Only a toolbar groups its buttons, as pills within
 *     one pill: the outer capsule is full-round, the inner pills sit 3px inside it with 2px
 *     between them, so the two are concentric.
 *   - A pill or toolbar that floats over the page wears the one floating glass; one inside a
 *     surface that already is glass (the composer) is a quiet 6.5% ink tint instead.
 *   - Sizes are calternal's at 100% interface size and scale with it (--cf-ui-scale): a toolbar
 *     32px with 26px pills, a pill alone 30px, icons 20px; on phones 44px and 22px.
 *
 * The glass is a ::before layer (never a backdrop-filter on the button or its ancestors: that
 * would make a backdrop root, see AGENTS.md).
 */
import { R } from "./selectors";

/** calternal's px at 100% interface size, scaled with it. */
export const s = (px: number) => `calc(${px}px * var(--cf-ui-scale, 1))`;

/** The floating glass as a layer: put these declarations on a ::before of a stacking context. */
export const GLASS_LAYER = `
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  background: rgb(var(--cf-pill-tint) / var(--cf-pill-alpha));
  -webkit-backdrop-filter: var(--cf-pill-filter);
  backdrop-filter: var(--cf-pill-filter);
  box-shadow: var(--cf-pill-shade), var(--cf-pill-edge), var(--cf-pill-shadow);
`;

export const PILL_CSS = `
${R} {
  /* calternal's floating glass, light (tokens.css). */
  --cf-pill-tint: 253 250 245;
  --cf-pill-alpha: 0.42;
  --cf-pill-filter: blur(24px) saturate(170%) brightness(1.03);
  --cf-pill-shade: inset 0 0 20px rgb(253 250 245 / 0.3);
  --cf-pill-edge: inset 0 0 0 1px rgb(255 255 255 / 0.5), inset 0 1px 0 rgb(255 255 255 / 0.6);
  --cf-pill-shadow: 0 0 0 1px rgb(31 27 23 / 0.05), 0 10px 28px -8px rgb(60 40 20 / 0.26), 0 2px 4px -1px rgb(60 40 20 / 0.08);
  --cf-pill-quiet: color-mix(in oklab, var(--foreground) 6.5%, transparent);
  --cf-pill-hover: color-mix(in oklab, var(--foreground) 9%, transparent);
  /* Sizes (desktop). */
  --cf-tb: ${s(32)};
  --cf-tb-pad: ${s(3)};
  --cf-tb-gap: ${s(2)};
  --cf-tb-pill: calc(var(--cf-tb) - 2 * var(--cf-tb-pad));
  --cf-pill: ${s(30)};
  --cf-pill-icon: ${s(20)};
}
${R}.dark {
  --cf-pill-tint: 30 28 26;
  --cf-pill-alpha: 0.5;
  --cf-pill-filter: blur(24px) saturate(160%) brightness(0.92);
  --cf-pill-shade: inset 0 0 20px rgb(16 15 14 / 0.3);
  --cf-pill-edge: inset 0 0 0 1px rgb(255 255 255 / 0.1), inset 0 1px 0 rgb(255 255 255 / 0.14);
  --cf-pill-shadow: 0 0 0 1px rgb(255 255 255 / 0.08), 0 12px 30px -10px rgb(0 0 0 / 0.55);
}

/* ── The card's top-right toolbar: bb's header actions (open in app ▾, right panel) as one
   glass toolbar. Their wrappers are flattened so every button is a pill of the toolbar. */
${R} main header div:has(> [data-thread-header-pane-actions]) {
  position: relative;
  isolation: isolate;
  height: var(--cf-tb);
  padding: var(--cf-tb-pad);
  gap: var(--cf-tb-gap);
  border-radius: 999px;
}
${R} main header div:has(> [data-thread-header-pane-actions])::before {
${GLASS_LAYER}}
${R} main header div:has(> [data-thread-header-pane-actions]) :is([data-thread-header-workflow-actions], [data-thread-header-pane-actions], [data-thread-header-responsive-action], [data-thread-header-responsive-action] *:not(button):not(button *)) {
  display: contents;
}

/* The card's top-right corner is the device radius (62px): at bb's own right padding the
   capsule came within ~5px of the curve while sitting 10px below the top. A 30px inset gives it
   about the same clearance from the curve as from the top edge. Desktop only (phones: TopPills). */
@media (min-width: 768px) {
  ${R} main header [data-testid="app-page-header-content-row"]:has([data-thread-header-pane-actions]) { padding-right: ${s(12)}; } /* bb's row already ends ~18px in: 30 in total */
}

/* ── A pill: inside a toolbar it takes the toolbar's inner size. */
${R} main header div:has(> [data-thread-header-pane-actions]) button {
  height: var(--cf-tb-pill);
  min-width: var(--cf-tb-pill);
  margin: 0 !important;
  padding: 0 0.625rem;
  border: 0 !important;
  border-radius: 999px !important;
  background: transparent;
  box-shadow: none !important;
  color: var(--foreground);
}
/* Icon-only buttons are circles. */
${R} main header div:has(> [data-thread-header-pane-actions]) button:is(:has(> svg:only-child), :has(> span.size-4:only-child)) {
  width: var(--cf-tb-pill);
  padding: 0;
}

/* ── A pill on its own: Thread actions (⋯) beside the title, a separate action. */
${R} main header button[aria-label="Thread actions"] {
  position: relative;
  isolation: isolate;
  width: var(--cf-pill);
  height: var(--cf-pill);
  border-radius: 999px;
  color: var(--foreground);
}
${R} main header button[aria-label="Thread actions"]::before {
${GLASS_LAYER}}

/* ── Every pill: one icon size, the hover tint, the press. */
${R} main header :is(div:has(> [data-thread-header-pane-actions]) button, button[aria-label="Thread actions"]) :is(svg, span.size-4) {
  width: var(--cf-pill-icon);
  height: var(--cf-pill-icon);
}
${R} main header :is(div:has(> [data-thread-header-pane-actions]) button, button[aria-label="Thread actions"]) {
  transition: scale 150ms cubic-bezier(0.2, 0.8, 0.2, 1), background-color 150ms ease, color 150ms ease;
}
@media (hover: hover) {
  ${R} main header :is(div:has(> [data-thread-header-pane-actions]) button, button[aria-label="Thread actions"]):not(:disabled):hover {
    background: var(--cf-pill-hover);
  }
}
${R} main header :is(div:has(> [data-thread-header-pane-actions]) button, button[aria-label="Thread actions"]):not(:disabled):active {
  scale: 0.97;
}
@media (prefers-reduced-motion: reduce) {
  ${R} main header :is(div:has(> [data-thread-header-pane-actions]) button, button[aria-label="Thread actions"]) { transition: none; }
}
`;

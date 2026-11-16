/**
 * The pill UI, after calternal's (packages/ui: Pill, Toolbar, Glass; TASTE.md). Read-only
 * reference: values and rules are taken over, the code is our own CSS over bb's buttons.
 *
 *   - A pill is a round button: 0.97 press, 9% ink hover tint, the warm tooltip, one icon size.
 *   - Separate actions are separate pills. Only a toolbar groups its buttons, as segments of one
 *     full-round capsule (SEGMENT below); a segment's highlight is concentric with the capsule.
 *   - A pill or toolbar that floats over the page wears the one floating glass; one inside a
 *     surface that already is glass (the composer) is a quiet 6.5% ink tint instead.
 *   - Sizes (desktop) are Apple's macOS 26/27 toolbar metrics at 100% interface size, scaled with it
 *     (--cf-ui-scale): one control height, 36px, for every top-row and composer control (a lone
 *     circle is 36x36, a toolbar 36 tall); inside a toolbar the items are plain 38px segments with
 *     no inner circle, and hover/press draw a highlight pill inside the segment (3px in from top and
 *     bottom, 2px from its sides); icons 16px (macOS 27 glyphs measured 14-16); 8px between separate controls and between groups;
 *     text pills (title, model, usage) 36 tall with 12px side padding. Phones (< 768px) use iOS 27's
 *     navigation-bar metrics in the same model: 44px circles and capsules, 48px segments, 20px
 *     glyphs, 8px gaps (pills-phone.ts adds the 20px side inset). Every pill file consumes these
 *     tokens, so one change here moves them all.
 *
 * The glass is a ::before layer (never a backdrop-filter on the button or its ancestors: that
 * would make a backdrop root, see AGENTS.md).
 */
import { R } from "./selectors";

/** px at 100% interface size, scaled with it. */
export const s = (px: number) => `calc(${px}px * var(--cf-ui-scale, 1))`;

/**
 * A toolbar item: a plain segment of its capsule, the capsule's full height. Its hover/press
 * highlight is its own background, clipped to the padding box: a transparent border insets it
 * --cf-seg-iy from top and bottom and --cf-seg-ix from the sides. The radius is chosen so that the
 * inner (padding-box) corner is a true pill: outer horizontal radius = h/2 - iy + ix, vertical = h/2.
 * No pseudo-element: bb's permission button already draws its icon on ::before, and the sidebar
 * uses ::after for hit areas.
 */
export const SEGMENT = `
  box-sizing: border-box;
  width: var(--cf-seg-w);
  min-width: var(--cf-seg-w);
  height: var(--cf-tb-pill);
  padding: 0;
  margin: 0;
  flex: none;
  justify-content: center;
  border: solid transparent !important;
  border-width: var(--cf-seg-iy) var(--cf-seg-ix) !important;
  background-clip: padding-box !important;
  border-radius: calc(var(--cf-tb-pill) / 2 - var(--cf-seg-iy) + var(--cf-seg-ix)) / calc(var(--cf-tb-pill) / 2) !important;
`;

/**
 * The floating glass as a layer: put these declarations on a ::before of a stacking context.
 *
 * Its fill is clear by default (the one glass). pill-contrast.ts sets `--cf-pill-wash` (0..1) on a pill whose
 * backdrop fights its glyphs (a photo or solid block under it, a bright patch of wallpaper in dark mode) and the
 * fill becomes the theme's pill tint at wash × `--cf-pill-wash-max`, only as much as 3:1 (icons) or 4.5:1
 * (words) needs (2026-11-16). `--cf-pill-solid` is the reduced-transparency floor. The 180ms fade keeps a code
 * block scrolling under a pill from flashing it; it is the fill alone (the backdrop isn't re-filtered for it).
 */
export const GLASS_LAYER = `
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  pointer-events: none;
  background: rgb(var(--cf-pill-tint) / min(1, calc(var(--cf-pill-alpha) + var(--cf-pill-wash, 0) * var(--cf-pill-wash-max) + var(--cf-pill-solid, 0))));
  transition: background-color 180ms var(--cf-ease-out);
  -webkit-backdrop-filter: var(--cf-pill-filter);
  backdrop-filter: var(--cf-pill-filter);
  box-shadow: var(--cf-pill-shade), var(--cf-pill-edge), var(--cf-pill-shadow);
`;

export const PILL_CSS = `
${R} {
  /* The pill glass, measured from iOS 27's own (Safari's toolbar pills over stripes, in the
     simulator): ~3px of blur and a strong light tint (~63% white) in light mode, ~3px and a
     light dark tint (~10%) in dark mode. calternal's 24px blur flattened a 44px pill into a
     smoky slab; Apple's keeps what is behind it recognisable. Dark uses 30%, not 10%: our pills
     sit over lines of chat text, and iOS adapts its tint to busy content, which CSS cannot.
     Pills that carry words (the title capsule) set a denser alpha of their own for contrast. */
  --cf-pill-tint: 253 250 245;
  --cf-pill-alpha: 0;                /* the one glass: no tint (css.ts --cf-glass) */
  --cf-pill-filter: var(--cf-glass);
  --cf-pill-wash-max: 0.35;          /* the most fill pill-contrast.ts can add (pill-contrast.ts WASH_MAX) */
  --cf-pill-shade: inset 0 0 20px rgb(253 250 245 / 0.3);
  --cf-pill-edge: inset 0 0 0 1px rgb(255 255 255 / 0.5), inset 0 1px 0 rgb(255 255 255 / 0.6);
  --cf-pill-shadow: 0 0 0 1px rgb(31 27 23 / 0.05), 0 10px 28px -8px rgb(60 40 20 / 0.26), 0 2px 4px -1px rgb(60 40 20 / 0.08);
  --cf-pill-quiet: color-mix(in oklab, var(--foreground) 6.5%, transparent);
  --cf-pill-hover: color-mix(in oklab, var(--foreground) 9%, transparent);
  /* Sizes (desktop): Apple's macOS 26/27 toolbar metrics (see the header comment). */
  --cf-ctl: ${s(36)};          /* the one control height: lone circles, toolbars, text pills */
  --cf-ctl-gap: ${s(8)};       /* between separate controls and between groups */
  --cf-tb: var(--cf-ctl);      /* a toolbar capsule */
  --cf-tb-pad: 0px;            /* its padding: segments fill it */
  --cf-tb-gap: 0px;            /* between its segments */
  --cf-tb-pill: calc(var(--cf-tb) - 2 * var(--cf-tb-pad)); /* a segment's height */
  --cf-seg-w: ${s(38)};        /* a segment's width */
  --cf-seg-iy: ${s(3)};        /* its highlight's inset from the capsule's top and bottom */
  --cf-seg-ix: ${s(2)};        /* and from the segment's sides */
  --cf-pill: var(--cf-ctl);    /* a pill alone (a circle) */
  --cf-pill-icon: ${s(16)};    /* Apple's toolbar glyphs measured 14-16 */
  --cf-text-h: var(--cf-ctl);  /* a pill with words */
  --cf-text-pad: ${s(12)};
}
/* Phones: iOS 27's navigation bar, measured in the simulator (Files, Settings, Safari): 44px round
   buttons (44.7pt), 44px capsules whose items are ~48px segments (back/forward 96.7pt for two),
   20px glyphs, 8px gaps. The segment highlight is the desktop one. */
@media (max-width: 767px) {
  ${R} {
    --cf-ctl: ${s(44)};
    --cf-seg-w: ${s(48)};
    --cf-pill-icon: ${s(20)};
  }
}
/* Reduced transparency (macOS/iOS "Reduce transparency"): the pills become a near-solid tint whatever is behind. */
@media (prefers-reduced-transparency: reduce) {
  ${R} { --cf-pill-solid: 0.85; }
}
${R}.dark {
  --cf-pill-tint: 30 28 26;
  --cf-pill-alpha: 0;
  --cf-pill-filter: var(--cf-glass);
  --cf-pill-shade: inset 0 0 20px rgb(16 15 14 / 0.3);
  --cf-pill-edge: inset 0 0 0 1px rgb(255 255 255 / 0.1), inset 0 1px 0 rgb(255 255 255 / 0.14);
  --cf-pill-shadow: 0 0 0 1px rgb(255 255 255 / 0.08), 0 12px 30px -10px rgb(0 0 0 / 0.55);
}

/* ── The card's top-right toolbar: bb's header actions (open in app ▾, right panel) as one
   glass toolbar. Their wrappers are flattened so every button is a pill of the toolbar. */
${R} main header div[data-cf-pane-tools] {
  position: relative;
  isolation: isolate;
  height: var(--cf-tb);
  padding: var(--cf-tb-pad);
  gap: var(--cf-tb-gap);
  border-radius: 999px;
}
${R} main header div[data-cf-pane-tools]::before {
${GLASS_LAYER}}
${R} main header div[data-cf-pane-tools] :is([data-thread-header-workflow-actions], [data-thread-header-pane-actions], [data-thread-header-responsive-action], [data-thread-header-responsive-action] *:not(button):not(button *)) {
  display: contents;
}

/* The card's top-right corner is the device radius (62px, squircle): at bb's own right padding the
   capsule came within ~5px of the curve. The inset keeps the capsule's end as far from the curve
   as its top is from the card's top edge. Desktop only (phones: TopPills). --cf-hd-inset is read
   by title-pill.ts too, so both ends of the header clear their corner alike. */
@media (min-width: 768px) {
  ${R} { --cf-hd-inset: ${s(16)}; } /* bb's row already ends ~18px in */
  ${R} main header [data-testid="app-page-header-content-row"]:has([data-thread-header-pane-actions]) { padding-right: var(--cf-hd-inset); }
}

/* ── A toolbar item: a segment (SEGMENT). One with words grows to fit them. */
${R} main header div[data-cf-pane-tools] button {
${SEGMENT}  margin: 0 !important;
  background-color: transparent;
  box-shadow: none !important;
  color: var(--foreground);
}
${R} main header div[data-cf-pane-tools] button:not(:has(> svg:only-child), :has(> span.size-4:only-child)) {
  width: auto;
  padding: 0 0.625rem;
}

/* ── The thread's ⋯ on its own: only on phones (pills-phone.ts builds on this). On desktop it is the
   trailing glyph of the title pill (title-pill.ts). */
@media (max-width: 767px) {
  ${R} main header button[aria-label="Thread actions"] {
    position: relative;
    isolation: isolate;
    width: var(--cf-pill);
    height: var(--cf-pill);
    border-radius: 999px;
    color: var(--foreground);
  }
  ${R} main header button[aria-label="Thread actions"]::before {
${GLASS_LAYER}  }
  ${R} main header button[aria-label="Thread actions"] :is(svg, span.size-4) {
    width: var(--cf-pill-icon);
    height: var(--cf-pill-icon);
  }
}

/* ── Every toolbar pill: one icon size, the hover tint, the press. (⋯ on phones: below.) */
${R} main header div[data-cf-pane-tools] button :is(svg, span.size-4) {
  width: var(--cf-pill-icon);
  height: var(--cf-pill-icon);
}
${R} main header div[data-cf-pane-tools] button {
  transition: scale 150ms var(--cf-ease-out), background-color 150ms ease, color 150ms ease;
}
@media (hover: hover) {
  ${R} main header div[data-cf-pane-tools] button:not(:disabled):hover {
    background-color: var(--cf-pill-hover);
  }
}
${R} main header div[data-cf-pane-tools] button:not(:disabled):active {
  scale: 0.97;
  background-color: var(--cf-pill-hover);
}
@media (max-width: 767px) {
  ${R} main header button[aria-label="Thread actions"] { transition: scale 150ms var(--cf-ease-out), background-color 150ms ease, color 150ms ease; }
  ${R} main header button[aria-label="Thread actions"]:not(:disabled):active { scale: 0.97; }
}
@media (prefers-reduced-motion: reduce) {
  ${R} main header :is(div[data-cf-pane-tools] button, button[aria-label="Thread actions"]) { transition: none; }
}
`;

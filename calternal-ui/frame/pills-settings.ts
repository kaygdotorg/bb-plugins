/**
 * The Settings sidebar's top row. Part of the pill UI: read frame/pills.ts first (tokens, SEGMENT, rules).
 *
 * bb's row (`settings-sidebar-top-reserve-row`) is [toggle overlay] [Search field] [‹ ›]. Like the main sidebar
 * (pills-sidebar.ts) it sits flat on the backdrop, so everything is the quiet tint, never glass:
 *   - the search field is a text pill: the control height, 999px round, quiet tint, its magnifier centred;
 *   - back/forward are one quiet toolbar of plain segments (pills.ts SEGMENT), the highlight drawn inside the
 *     segment on hover and press;
 *   - toggle, field and toolbar share one centre line with one gap between them. On phones the drawer hides
 *     the toggle (pills-phone.ts), so the field starts at the 20px side inset.
 * Desktop: Apple's macOS metrics through the shared tokens (36 tall, 38px segments, 16px icons, 8px gaps).
 * Phones: iOS 27's, measured (44 tall field with a 16px magnifier 14px in; a 44 capsule of ~48px segments with no
 * inner circles; 20px glyphs; 8px gaps; 20px side inset).
 */
import { R } from "./selectors";
import { SEGMENT, s } from "./pills";

const ROW = `${R} [data-testid="settings-sidebar-top-reserve-row"]`;
const WRAP = `${ROW} > div:has(> [data-sidebar-header-slot])`;
const FIELD = `${ROW} [data-sidebar-header-slot] > label`;
const NAV = `${ROW} > div:has(> button[aria-label="Go back"])`;
const BTN = `${NAV} > button`;

export const PILL_SETTINGS_CSS = `
${ROW} {
  --cf-st-h: var(--cf-ctl);
  --cf-st-gap: var(--cf-ctl-gap);
  --cf-st-seg: var(--cf-seg-w);
  --cf-st-iy: var(--cf-seg-iy);
  --cf-st-ix: var(--cf-seg-ix);
  --cf-st-icon: var(--cf-pill-icon);
  --cf-st-glyph: var(--cf-pill-icon);   /* the magnifier */
  --cf-st-pad-l: var(--cf-text-pad);
  --cf-st-pad-r: var(--cf-text-pad);
  /* bb's own row ends 0.5rem in, as the main sidebar's back/forward does: kept, so both rows end alike. */
  --cf-st-side: 0.5rem;
  /* Where the field starts: one gap after the toggle pill (bb's overlay starts at the rail padding less 2px;
     the pill is pills-sidebar.ts's). */
  --cf-st-start: calc(env(safe-area-inset-left) + var(--bb-sidebar-rail-padding, 12px) - 2px + var(--cf-sb-pill, var(--cf-pill)) + var(--cf-st-gap));
  gap: var(--cf-st-gap);
  padding-left: 0 !important;
  padding-right: var(--cf-st-side) !important;
}
${WRAP} { padding-left: var(--cf-st-start) !important; }
@media (max-width: 767px) {
  ${ROW} {
    --cf-st-h: ${s(44)};
    --cf-st-gap: ${s(8)};
    --cf-st-seg: ${s(48)};
    --cf-st-iy: ${s(3)};
    --cf-st-ix: ${s(2)};
    --cf-st-icon: ${s(20)};
    --cf-st-glyph: ${s(16)};
    --cf-st-pad-l: ${s(14)};
    --cf-st-pad-r: ${s(14)};
    --cf-st-side: var(--cf-ph-side, ${s(20)});
    /* The drawer hides the toggle pill on phones (pills-phone.ts), so the field starts at the side inset, like
       the main sidebar's wordmark (brand.ts). */
    --cf-st-start: calc(env(safe-area-inset-left) + var(--cf-ph-side, ${s(20)}));
  }
}

/* ── The search field: a quiet text pill. */
${FIELD} {
  box-sizing: border-box;
  height: var(--cf-st-h) !important;
  min-height: 0;
  padding: 0 var(--cf-st-pad-r) 0 var(--cf-st-pad-l) !important;
  gap: ${s(8)};
  border-radius: 999px;
  background: var(--cf-pill-quiet) !important;
  color: var(--muted-foreground);
  transition: background-color 150ms ease;
}
${FIELD}:focus-within { background: var(--cf-pill-hover) !important; }
@media (hover: hover) {
  ${FIELD}:hover { background: var(--cf-pill-hover) !important; }
}
${FIELD} > svg { width: var(--cf-st-glyph) !important; height: var(--cf-st-glyph) !important; flex: none; }
${FIELD} > input { height: 100%; padding: 0; }
${FIELD} > kbd { margin: 0 !important; }

/* ── Back/forward: one quiet toolbar of segments. */
${NAV} {
  display: flex;
  align-items: center;
  height: var(--cf-st-h);
  padding: 0;
  gap: 0;
  border-radius: 999px;
  background: var(--cf-pill-quiet);
  box-sizing: border-box;
}
${BTN} {
${SEGMENT}  --cf-seg-w: var(--cf-st-seg);
  --cf-tb-pill: var(--cf-st-h);
  --cf-seg-iy: var(--cf-st-iy);
  --cf-seg-ix: var(--cf-st-ix);
  background-color: transparent;
  color: var(--foreground);
  transition: scale 150ms var(--cf-ease-out), background-color 150ms ease, color 150ms ease;
}
${BTN} :is(svg, span.size-4) { width: var(--cf-st-icon) !important; height: var(--cf-st-icon) !important; }
@media (hover: hover) {
  ${BTN}:not([aria-disabled="true"]):hover { background-color: var(--cf-pill-hover); }
}
${BTN}:not([aria-disabled="true"]):active { scale: 0.97; background-color: var(--cf-pill-hover); }
@media (prefers-reduced-motion: reduce) { ${BTN}, ${FIELD} { transition: none; } }
`;

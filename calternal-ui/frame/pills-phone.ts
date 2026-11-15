/**
 * Phone header pills (calternal's TopPills). Part of the pill UI: read frame/pills.ts first (tokens, GLASS_LAYER, rules).
 *
 * On a phone (<768px) the chat header is no band, only floating glass over the page, 44px tall on one centre line:
 *   - back: bb's drawer button (a fixed overlay outside the header), a round glass pill on the left;
 *   - the title: a glass capsule, centred on the screen, padded 16px, truncating;
 *   - a toolbar on the right: the ⋯ thread actions and the right-panel button as pills within one glass capsule
 *     (44px outer, 38px inner, 3px padding, 2px gap). bb keeps ⋯ beside the title in its DOM, so ⋯ is flattened out
 *     of its wrappers and the toolbar's glass (a ::before of the right-hand container) reaches left to take it in.
 * Side insets are equal; the top inset leaves the pills clear of the 62px screen corner the pane takes on when it slides
 * aside (--cf-device-radius). The wrappers are flattened with display: contents (bb's DOM stays as it is).
 */
import { R } from "./selectors";
import { GLASS_LAYER, s } from "./pills";

const ROW = `${R} main header [data-testid="app-page-header-content-row"]`;
const TOGGLE = `${R} [data-testid="app-sidebar-trigger-overlay"]`;
const TOOLBAR = `div:has(> [data-thread-header-pane-actions])`;
const ACTIONS = `button[aria-label="Thread actions"]`;

export const PILL_PHONE_CSS = `
@media (max-width: 767px) {
  ${R} {
    --cf-tb: ${s(44)};
    --cf-pill: ${s(44)};
    --cf-pill-icon: ${s(22)};
    /* Equal inset left and right; the top inset keeps the pills off the screen's rounded corner. */
    --cf-ph-side: ${s(20)};
    --cf-ph-top: ${s(12)};
    --cf-ph-row: calc(var(--cf-tb) + 2 * var(--cf-ph-top));
    --bb-app-chrome-row-height: var(--cf-ph-row);
  }

  /* The header: a row of floating pills. Room on the left for the back pill. */
  ${R} main header { padding: 0; }
  ${ROW} {
    height: var(--cf-ph-row);
    padding-left: calc(var(--cf-ph-side) + var(--cf-tb) + ${s(8)}) !important;
    padding-right: var(--cf-ph-side) !important;
    gap: 0;
  }

  /* ── Back: bb's drawer button, a 44px glass circle. */
  ${TOGGLE} {
    height: var(--cf-ph-row);
    padding-left: var(--cf-ph-side) !important;
  }
  ${TOGGLE} button {
    position: relative;
    isolation: isolate;
    width: var(--cf-tb);
    height: var(--cf-tb);
    padding: 0;
    border-radius: 999px;
    color: var(--foreground);
    transition: scale 150ms cubic-bezier(0.2, 0.8, 0.2, 1), color 150ms ease;
  }
  ${TOGGLE} button::before {
${GLASS_LAYER}}
  ${TOGGLE} button :is(svg, span.size-4) { width: var(--cf-pill-icon); height: var(--cf-pill-icon); }
  ${TOGGLE} button:not(:disabled):active { scale: 0.97; }

  /* ── The title: a glass capsule on the screen's centre. Its wrappers (and the ⋯ span) are flattened. */
  ${ROW} > div:first-child,
  ${ROW} > div:first-child > div,
  ${ROW} > div:first-child > div > span:has(> ${ACTIONS}) { display: contents; }
  ${ROW} > div:first-child > div > div:has(.bb-thread-title) {
    position: absolute;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    display: flex;
    align-items: center;
    isolation: isolate;
    height: var(--cf-tb);
    /* Both sides reserve the toolbar's room, so the capsule stays centred. */
    max-width: calc(100% - 2 * (var(--cf-ph-side) + ${s(84)} + ${s(8)}));
    padding: 0 ${s(16)};
    border-radius: 999px;
    /* Words sit on this glass, and page text passes under it: a denser tint than the icon pills' keeps >= 4.5:1. */
    --cf-pill-alpha: 0.78;
  }
  ${R}.dark ${ROW} > div:first-child > div > div:has(.bb-thread-title) { --cf-pill-alpha: 0.72; }
  ${ROW} > div:first-child > div > div:has(.bb-thread-title)::before {
${GLASS_LAYER}}
  ${ROW} > div:first-child > div > div:has(.bb-thread-title) > p {
    font-size: ${s(15)};
    font-weight: 620;
    letter-spacing: -0.01em;
    line-height: 1.2;
    color: var(--foreground);
  }

  /* ── The toolbar: ⋯ and the right-hand buttons as pills within one glass capsule. The container's glass reaches
     left over ⋯ (2px gap + 38px pill + 3px padding). */
  ${ROW} { --cf-tb-reach: calc(var(--cf-tb-pill) + var(--cf-tb-gap) + var(--cf-tb-pad)); }
  ${ROW} > ${TOOLBAR} { margin-left: auto; }
  ${ROW}:has(${ACTIONS}) > ${TOOLBAR} { padding-left: 0; }
  ${ROW}:has(${ACTIONS}) > ${TOOLBAR}::before { left: calc(-1 * var(--cf-tb-reach)); }
  ${ROW} ${ACTIONS} {
    z-index: 1;
    width: var(--cf-tb-pill);
    height: var(--cf-tb-pill);
    margin: 0 var(--cf-tb-gap) 0 0;
    margin-left: auto;
  }
  ${ROW} ${ACTIONS}::before { content: none; }
  ${ROW} ${ACTIONS} :is(svg, span.size-4) { width: var(--cf-pill-icon); height: var(--cf-pill-icon); }
  /* The thread's actions are the toolbar's first pill: it carries the toolbar's left padding. */
  ${ROW}:has(${ACTIONS}) > ${TOOLBAR} { margin-left: 0; }
}
`;

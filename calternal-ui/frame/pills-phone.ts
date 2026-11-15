/**
 * Phone header pills (calternal's TopPills). Part of the pill UI: read frame/pills.ts first (tokens, GLASS_LAYER, rules).
 *
 * On a phone (<768px) the chat header is no band, only floating glass over the page, 44px tall on one centre line:
 *   - back: bb's drawer button (a fixed overlay outside the header), a round glass pill on the left;
 *   - the title: a glass capsule, centred on the screen, padded 16px, truncating;
 *   - a toolbar on the right: the ⋯ thread actions and the right-panel button as two segments of one glass capsule
 *     (44px tall, 48px segments: iOS 27's metrics, pills.ts). bb keeps ⋯ beside the title in its DOM, so ⋯ is
 *     flattened out of its wrappers and the toolbar's glass (a ::before of the right-hand container) reaches left
 *     to take it in.
 * Side insets are equal; the top inset leaves the pills clear of the 62px screen corner the pane takes on when it slides
 * aside (--cf-device-radius). The wrappers are flattened with display: contents (bb's DOM stays as it is).
 */
import { R } from "./selectors";
import { GLASS_LAYER, SEGMENT, s } from "./pills";

const ROW = `${R} main header [data-testid="app-page-header-content-row"]`;
const TOGGLE = `${R} [data-testid="app-sidebar-trigger-overlay"]`;
const TOOLBAR = `div:has(> [data-thread-header-pane-actions])`;
const ACTIONS = `button[aria-label="Thread actions"]`;

export const PILL_PHONE_CSS = `
@media (max-width: 767px) {
  ${R} {
    /* Heights, segments and glyphs are pills.ts's phone tokens (44, 48, 20).
       Equal inset left and right (iOS 27: 20px); the top inset keeps the pills off the screen's rounded corner. */
    --cf-ph-side: ${s(20)};
    --cf-ph-top: ${s(12)};
    --cf-ph-row: calc(var(--cf-tb) + 2 * var(--cf-ph-top));
    --bb-app-chrome-row-height: var(--cf-ph-row);
  }

  /* The header: a row of floating pills. Room on the left for the back pill. */
  ${R} main header { padding: 0; }
  ${ROW} {
    height: var(--cf-ph-row);
    padding-left: calc(var(--cf-ph-side) + var(--cf-pill) + var(--cf-ctl-gap)) !important;
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
    width: var(--cf-pill);
    height: var(--cf-pill);
    padding: 0;
    border-radius: 999px;
    color: var(--foreground);
    transition: scale 150ms var(--cf-ease-out), color 150ms ease;
  }
  ${TOGGLE} button::before {
${GLASS_LAYER}}
  ${TOGGLE} button :is(svg, span.size-4) { width: var(--cf-pill-icon); height: var(--cf-pill-icon); }
  ${TOGGLE} button:not(:disabled):active { scale: 0.97; }
  /* While the drawer is open the toggle is pointless (a swipe closes it): like Claude's iOS app, the
     drawer's top row is the wordmark at the 20px inset (brand.ts) and the back/forward toolbar. The
     button stays in the DOM, visually hidden and out of the layout, for assistive tech. */
  ${R}:has(main[data-sidebar="inset"][data-sidebar-shelf]:not([data-sidebar-shelf="closed"])) ${TOGGLE.replace(R + " ", "")} button {
    position: absolute;
    width: 1px;
    height: 1px;
    min-width: 0;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

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
    height: var(--cf-text-h);
    /* Both sides reserve the toolbar's room (two segments), so the capsule stays centred. */
    max-width: calc(100% - 2 * (var(--cf-ph-side) + 2 * var(--cf-seg-w) + 2 * var(--cf-tb-pad) + var(--cf-tb-gap) + var(--cf-ctl-gap)));
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

  /* ── The toolbar: ⋯ and the right-hand buttons as segments of one glass capsule. The container's glass reaches
     left over ⋯ (one segment, plus the toolbar's gap and padding, both 0 with segments). */
  ${ROW} { --cf-tb-reach: calc(var(--cf-seg-w) + var(--cf-tb-gap) + var(--cf-tb-pad)); }
  ${ROW} > ${TOOLBAR} { margin-left: auto; }
  ${ROW}:has(${ACTIONS}) > ${TOOLBAR} { padding-left: 0; }
  ${ROW}:has(${ACTIONS}) > ${TOOLBAR}::before { left: calc(-1 * var(--cf-tb-reach)); }
  ${ROW} ${ACTIONS} {
${SEGMENT}    z-index: 1;
    margin: 0 var(--cf-tb-gap) 0 auto;
    background-color: transparent;
  }
  ${ROW} ${ACTIONS}:not(:disabled):active { background-color: var(--cf-pill-hover); }
  ${ROW} ${ACTIONS}::before { content: none; }
  ${ROW} ${ACTIONS} :is(svg, span.size-4) { width: var(--cf-pill-icon); height: var(--cf-pill-icon); }
  /* The thread's actions are the toolbar's first pill: it carries the toolbar's left padding. */
  ${ROW}:has(${ACTIONS}) > ${TOOLBAR} { margin-left: 0; }
}
`;

/**
 * Phone header pills (calternal's TopPills). Part of the pill UI: read frame/pills.ts first (tokens, GLASS_LAYER, rules).
 *
 * On a phone (<768px) the chat header is no band, only floating glass over the page, 44px tall on one centre line:
 *   - back: bb's drawer button (a fixed overlay outside the header), a round glass pill on the left;
 *   - the title: a glass capsule, leading (one gap after the back pill), padded 16px, truncating;
 *   - ⋯ on the right: a 44px glass circle. bb's right toolbar (the right-panel button) is hidden; its buttons are
 *     the ⋯ menu's first items (phone-menu.ts). bb keeps ⋯ beside the title in its DOM, so ⋯ is flattened out of
 *     its wrappers and pushed to the row's end.
 * Side insets are equal; the top inset leaves the pills clear of the 62px screen corner the pane takes on when it slides
 * aside (--cf-device-radius). The wrappers are flattened with display: contents (bb's DOM stays as it is).
 */
import { R } from "./selectors";
import { GLASS_LAYER, s } from "./pills";

const ROW = `${R} main header [data-testid="app-page-header-content-row"]`;
const TOGGLE = `${R} [data-testid="app-sidebar-trigger-overlay"]`;
/** marks.ts stamps these (non-subject :has() is costly: see marks.ts). */
const TOOLBAR = `div[data-cf-pane-tools]`;
const ACTIONS = `button[aria-label="Thread actions"]`;

export const PILL_PHONE_CSS = `
@media (max-width: 767px) {
  ${R} {
    /* Heights, segments and glyphs are pills.ts's phone tokens (44, 48, 20).
       Side inset as iOS 27 sets it by screen width (measured, Files/Settings/Messages): 16pt on the 402pt
       Pro, 20pt on the 440pt Pro Max. The pills sit right under the status bar (Claude's and the system
       nav bars' top: y=62 on a Pro Max), with 4pt above and below inside the row. */
    --cf-ph-side: ${s(16)};
    --cf-ph-top: ${s(4)};
    --cf-ph-row: calc(var(--cf-tb) + 2 * var(--cf-ph-top));
    --bb-app-chrome-row-height: var(--cf-ph-row);
  }

  @media (min-width: 430px) { ${R} { --cf-ph-side: ${s(20)}; } }

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
  ${R}[data-cf-shelf-open] ${TOGGLE.replace(R + " ", "")} button {
    position: absolute;
    width: 1px;
    height: 1px;
    min-width: 0;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  /* ── The title: a glass capsule, leading: one gap after the back pill (kayg: left, not centred; like the
     drawer's wordmark). Its wrappers (and the ⋯ span) are flattened. */
  ${ROW} > div:first-child,
  ${ROW} > div:first-child > div,
  ${ROW} > div:first-child > div > span:has(> ${ACTIONS}) { display: contents; }
  ${ROW} > div:first-child > div > div:has(.bb-thread-title) {
    position: absolute;
    left: calc(var(--cf-ph-side) + var(--cf-pill) + var(--cf-ctl-gap));
    top: 50%;
    translate: 0 -50%;
    display: flex;
    align-items: center;
    isolation: isolate;
    height: var(--cf-text-h);
    /* Up to one gap before the ⋯ pill on the right. */
    max-width: calc(100% - 2 * (var(--cf-ph-side) + var(--cf-pill) + var(--cf-ctl-gap)));
    padding: 0 ${s(16)};
    border-radius: 999px;
  }
  ${ROW} > div:first-child > div > div:has(.bb-thread-title)::before {
${GLASS_LAYER}}
  ${ROW} > div:first-child > div > div[data-cf-title-wrap] > p {
    font-size: ${s(15)};
    font-weight: 620;
    letter-spacing: -0.01em;
    line-height: 1.2;
    color: var(--foreground);
  }

  /* ── The right end: ⋯ alone, a 44px glass circle like the back pill. bb's right toolbar (the right-panel
     button, workflow buttons) is hidden: its buttons are the ⋯ menu's first items (phone-menu.ts). */
  ${ROW} > ${TOOLBAR} { display: none !important; }
  ${ROW} ${ACTIONS} {
    position: relative;
    isolation: isolate;
    z-index: 1;
    width: var(--cf-pill);
    height: var(--cf-pill);
    min-width: var(--cf-pill);
    margin: 0 0 0 auto;
    padding: 0;
    border-radius: 999px;
    background-color: transparent;
    color: var(--foreground);
    transition: scale 150ms var(--cf-ease-out);
  }
  ${ROW} ${ACTIONS}::before {
${GLASS_LAYER}}
  ${ROW} ${ACTIONS}:not(:disabled):active { scale: 0.97; }
  ${ROW} ${ACTIONS} :is(svg, span.size-4) { width: var(--cf-pill-icon); height: var(--cf-pill-icon); }
}
`;

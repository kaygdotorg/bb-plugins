/**
 * Selectors for bb's own shell DOM (bb 0.49). Everything the frame styles is found through
 * these, and everything is gated on the root attribute, so removing that attribute
 * restores bb exactly. If bb renames a data attribute, this is the file to fix.
 */
export const ROOT_ATTR = "data-calternal-frame";

export const R = `html[${ROOT_ATTR}]`;
export const SHELL = `${R} [data-testid="app-layout-root"]`;
export const MAIN = `${SHELL} main[data-sidebar="inset"]`;
/** The outermost panel group in the center: nested thread groups are left alone. */
export const GROUP = `${MAIN} [data-panel-group]:not([data-panel] [data-panel-group])`;
export const CARD_PANEL = `${GROUP} > [data-panel]:not([data-panel] ~ [data-panel])`;
export const SIDE_PANEL = `${GROUP} > [data-panel] ~ [data-panel]`;
/** Pages without a panel group (Settings, Skills): their content shell is the card. */
export const PLAIN_MAIN = `${MAIN}:not(:has([data-panel-group]))`;
export const CARD_FALLBACK = `${PLAIN_MAIN} > [data-app-content-shell]`;
export const SIDEBAR = `${SHELL} [data-sidebar="sidebar"]`;
/** Surfaces that have no fill of their own: they show the window backdrop. */
export const FLAT = `${SIDEBAR}, ${SIDE_PANEL}`;
export const CARD = `${CARD_PANEL}, ${CARD_FALLBACK}`;
export const BACKDROP = `${R} [data-cf-backdrop]`;

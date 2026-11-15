// The one definition of the switch-over boundary, used by live capture and backfill.
//
// The marker is the last `turn/completed` seq before the BB_HONCHO env event (or, for
// threads that predate the plugin, the thread's max seq when the plugin first saw it).
// Everything at or below the marker belongs to the harness's own capture / to opt-in
// backfill; everything above it belongs to live capture. A seq is on exactly one side.

/** Live capture covers seq > marker; its cursor starts here. */
export const captureCursorStart = (marker: number): number => marker;
export const isCaptured = (seq: number, marker: number | undefined): boolean => marker === undefined || seq > marker;

/** Backfill covers seq <= marker. With no marker, live capture hasn't claimed anything yet. */
export const isBackfilled = (seq: number, marker: number | undefined): boolean => marker === undefined || seq <= marker;
/** Backfill's cursor once it has covered everything it owns. */
export const backfillCursorEnd = (marker: number): number => marker;

/** The switch-over gate is always open for providers that have no harness hooks to turn off. */
export const gateAlwaysOpen = (providerId: string) => providerId === "pi" || /^acp(?:[-:_]|$)/.test(providerId);

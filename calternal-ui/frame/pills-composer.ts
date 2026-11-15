/**
 * Composer pills: the composer's bottom row. Part of the pill UI: read frame/pills.ts first (tokens, GLASS_LAYER, rules).
 *
 *   [+] [model] [toolbar: ring, permission, environment] ··· [mic] [send]
 *
 * The composer already is glass, so every pill here is the quiet tint (never glass on glass).
 * Separate actions are separate pills; the ring, permission and environment form one toolbar
 * (composer.ts pins bb's footer row after the model pill and css.ts's composer section makes it
 * the capsule). Siblings are one gap apart (--cf-cgap), everything shares one centre line.
 * Phones (< 768px): 44px pills, 22px icons.
 */
import { R } from "./selectors";
import { s } from "./pills";

const C = `${R} [data-app-composer]`;
const ROW = `${C} [data-promptbox-action-row]`;
/** Every button of the row except bb's filled send. */
const FILLED = ["button[data-promptbox-submit-action]", 'button[aria-label="Send voice input"]', "[data-promptbox-send-menu] > button"];
const PILL = `${ROW} button${FILLED.map((x) => `:not(${x.replace(/^button/, "")})`).join("")}`;
const SEND = FILLED.map((x) => `${ROW} ${x}`).join(", ");
/** bb's send with text in the draft: a split button (send | options) in one filled capsule. */
const SPLIT = `${ROW} [data-promptbox-send-menu]`;
const TOOL = `${C}[data-cf-merged] [data-follow-up-composer-footer] :is(button, [data-cf-env])`;

export const PILL_COMPOSER_CSS = `
${R} {
  --cf-cp: ${s(30)};        /* a pill alone */
  --cf-ci: ${s(20)};        /* its icon */
  --cf-tb-c: ${s(32)};      /* the toolbar capsule */
  --cf-tbp-c: calc(var(--cf-tb-c) - 2 * var(--cf-tb-pad)); /* its pills: 26 */
  --cf-cgap: ${s(6)};       /* between sibling pills */
  --cf-cinset: ${s(8)};     /* the row's inset from the composer's edge */
}
@media (max-width: 767px) {
  ${R} {
    --cf-cp: ${s(44)};
    --cf-ci: ${s(22)};
    --cf-tb-c: ${s(44)};
  }
}

/* The row: one centre line, one gap. bb's padding (pb-2 pl-3.5 pr-13) gives way to an even inset. */
${ROW} {
  align-items: center;
  gap: var(--cf-cgap);
  padding: ${s(4)} var(--cf-cinset) var(--cf-cinset);
}
${ROW} > [data-promptbox-standard-actions] { align-items: center; gap: var(--cf-cgap); }
${ROW} > [data-promptbox-standard-actions] > span { display: inline-flex; gap: var(--cf-cgap); } /* mic + the keyboard-down button */

/* The one-line composer: bb fixes its line at 48px, so 44px pills would sit 3px from the edge. The
   line grows to a pill plus the same inset as everywhere else. */
${C}[data-cf-collapsed] [data-promptbox-layout] { grid-template-rows: calc(var(--cf-cp) + 2 * var(--cf-cinset)) !important; }
${C}[data-cf-collapsed] [data-promptbox-main] { height: calc(var(--cf-cp) + 2 * var(--cf-cinset)) !important; }

/* A pill: round, the quiet tint, one icon size. */
${PILL}, ${SEND} {
  box-sizing: border-box;
  height: var(--cf-cp);
  width: var(--cf-cp);
  min-width: var(--cf-cp);
  margin: 0 !important;
  padding: 0 !important;
  border-radius: 999px !important;
  flex: none;
}
${PILL} {
  background: var(--cf-pill-quiet);
  color: var(--muted-foreground);
  transition: scale 150ms var(--cf-ease-out), background-color 150ms ease, color 150ms ease;
}
${ROW} button :is(svg, [data-icon-root]) { width: var(--cf-ci) !important; height: var(--cf-ci) !important; }

/* The model pill: icon, "Opus 5.5 Medium", chevron. bb's gap-1 plus css.ts's optical nudges keep
   icon → text → chevron reading even. The logo fills its box while the chevron glyph sits ~4px
   inside its box, so the right padding is smaller than the left to look the same. */
${PILL}[aria-label^="Provider, model"] {
  width: auto;
  max-width: 100%;
  padding-inline: ${s(12)} ${s(8)} !important;
}
${ROW} button[aria-label^="Provider, model"] [data-provider-logo] ,
${ROW} button[aria-label^="Provider, model"] > span.contents > span:first-child { width: calc(var(--cf-ci) * 0.8); height: calc(var(--cf-ci) * 0.8); }
${ROW} button[aria-label^="Provider, model"] > svg[data-icon-root] { width: calc(var(--cf-ci) * 0.8) !important; height: calc(var(--cf-ci) * 0.8) !important; }

/* Phones: the toolbar's 124px and two pills of the right-hand group leave the model pill only its
   icon and chevron (its name is the tooltip and aria-label); the toolbar steps aside while the
   keyboard is up, and the model pill gets its name back. */
@media (max-width: 767px) {
  ${R}:not([data-cf-keyboard]) [data-app-composer] [data-promptbox-action-row] button[aria-label^="Provider, model"] :is(.truncate, [data-promptbox-hide-compact]) { display: none; }
  ${R}[data-cf-keyboard] [data-app-composer] [data-follow-up-composer-footer] { display: none !important; }
}

/* Voice recording (frame/voice.ts): bb's recording row covers the row and brings its own padding
   (px-2 py-1.5, 48px tall). It gets the row's: the same inset and centre line, with the cancel,
   stop and send pills at the same size and the waveform pill as tall as they are. */
${ROW} [data-promptbox-voice-controls] > div {
  box-sizing: border-box;
  height: 100%;
  gap: var(--cf-cgap);
  padding: ${s(4)} var(--cf-cinset) var(--cf-cinset);
}

${SPLIT} { margin: 0 !important; height: var(--cf-cp); border-radius: 999px !important; overflow: hidden; }
${SPLIT} > button { width: var(--cf-cp); border-radius: 0 !important; }

/* Send: bb's filled primary keeps its fill; only the shape matches. */
${SEND} { transition: scale 150ms var(--cf-ease-out), filter 150ms ease; }

/* The toolbar's pills (ring, permission, environment): inner pills, transparent until hovered. */
${TOOL} {
  border-radius: 999px;
  background: transparent;
  transition: scale 150ms var(--cf-ease-out), background-color 150ms ease, color 150ms ease;
}
${TOOL} :is(svg[data-icon-root], svg) { width: var(--cf-ci) !important; height: var(--cf-ci) !important; }
${C} [data-cf-env] > * { width: 100%; height: 100%; }
${C}[data-cf-merged] [data-follow-up-composer-footer] button[aria-label^="Context window"] svg { margin: 0; }

@media (hover: hover) {
  ${PILL}:not(:disabled):hover, ${TOOL}:not(:disabled):hover { background: var(--cf-pill-hover); }
  ${SEND}:not(:disabled):hover { filter: brightness(1.08); }
}
${PILL}:not(:disabled):active, ${SEND}:not(:disabled):active, ${TOOL}:active { scale: 0.97; }
@media (prefers-reduced-motion: reduce) {
  ${PILL}, ${SEND}, ${TOOL} { transition: none; }
}
`;

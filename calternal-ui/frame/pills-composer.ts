/**
 * Composer pills: the composer's bottom row. Part of the pill UI: read frame/pills.ts first (tokens, GLASS_LAYER, rules).
 *
 *   [+] [model] [toolbar: ring, permission, environment] ··· [mic] [send]
 *
 * The composer already is glass, so every pill here is the quiet tint (never glass on glass).
 * Separate actions are separate pills; the ring, permission and environment form one toolbar
 * (composer.ts pins bb's footer row after the model pill and css.ts's composer section makes it
 * the capsule), whose items are segments (pills.ts SEGMENT). Siblings are one gap apart
 * (--cf-cgap), everything shares one centre line. Desktop sizes are pills.ts's shared tokens
 * (desktop 36px controls, 38px segments, 16px icons; phones 44px, 48px segments, 20px glyphs; 8px gaps).
 */
import { R } from "./selectors";
import { SEGMENT, s } from "./pills";

const C = `${R} [data-app-composer]`;
const ROW = `${C} [data-promptbox-action-row]`;
/** Every button of the row except bb's filled send. */
const FILLED = ["button[data-promptbox-submit-action]", 'button[aria-label="Send voice input"]', "[data-promptbox-send-menu] > button"];
const PILL = `${ROW} button${FILLED.map((x) => `:not(${x.replace(/^button/, "")})`).join("")}`;
/** The model pill while the toolbar sits after it: its end margin is the toolbar's room (composer.ts --cf-foot-room). */
const MODEL_MERGED = `${PILL.replace(C, `${C}[data-cf-merged]`)}[aria-label^="Provider, model"]`;
/** One selector (wrapped in :is), so a suffix like :active applies to every filled button, not only the last of the list. */
const SEND = `:is(${FILLED.map((x) => `${ROW} ${x}`).join(", ")})`;
/** bb's send with text in the draft: a split button (send | options) in one filled capsule. */
const SPLIT = `${ROW} [data-promptbox-send-menu]`;
const TOOL = `${C}[data-cf-merged] [data-follow-up-composer-footer] :is(button, [data-cf-env])`;

export const PILL_COMPOSER_CSS = `
${R} {
  --cf-cp: var(--cf-pill);      /* a pill alone */
  --cf-ci: var(--cf-pill-icon); /* its icon */
  --cf-tb-c: var(--cf-tb);      /* the toolbar capsule */
  --cf-tbp-c: calc(var(--cf-tb-c) - 2 * var(--cf-tb-pad)); /* its segments' height */
  --cf-cgap: var(--cf-ctl-gap); /* between sibling pills */
  --cf-cinset: ${s(8)};         /* the row's inset from the composer's edge */
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
  height: var(--cf-text-h);
  padding-inline: var(--cf-text-pad) calc(var(--cf-text-pad) - ${s(4)}) !important;
}
${ROW} button[aria-label^="Provider, model"] [data-provider-logo] ,
${ROW} button[aria-label^="Provider, model"] > span.contents > span:first-child { width: calc(var(--cf-ci) * 0.8); height: calc(var(--cf-ci) * 0.8); }
${ROW} button[aria-label^="Provider, model"] > svg[data-icon-root] { width: calc(var(--cf-ci) * 0.8) !important; height: calc(var(--cf-ci) * 0.8) !important; }

/* The toolbar is placed after the model pill (absolutely, composer.ts); the model pill's end margin
   keeps its room, so whatever follows in the left group (the phone's attachment chip) comes after it.
   When it does not fit whole, composer.ts sets data-cf-foot-off and it steps aside. */
${MODEL_MERGED} { margin-inline-end: var(--cf-foot-room, 0px) !important; }
${C}[data-cf-foot-off] [data-follow-up-composer-footer] { visibility: hidden; pointer-events: none; }

/* Phones: the toolbar's three 48px segments and two pills of the right-hand group leave the model pill only its
   icon and chevron (its name is the tooltip and aria-label); the toolbar steps aside while the
   keyboard is up, and the model pill gets its name back. Short of room (the keyboard button and an
   attachment chip beside it), the name truncates rather than running under its neighbours. */
@media (max-width: 767px) {
  /* ── Like Claude's iOS composer (measured, 2026-11-15): collapsed it is a 52pt capsule, its +, mic and send
     36pt circles 8pt inside its edge with 8pt between them, the text 17pt; expanded, the corners (26pt)
     stay concentric with that capsule. Its glass is the one glass (css.ts --cf-glass).
     page (it was level with it). */
  ${R} {
    --cf-cp: ${s(36)};
    --cf-ci: ${s(18)};
    --cf-cinset: ${s(8)};
    /* The merged toolbar (status, permission, branch) matches the pills beside it: 36 tall, 18pt icons
       (it kept the 44pt toolbar size, kayg: "icons inconsistent in sizing"). */
    --cf-tb-c: ${s(36)};
  }
  ${TOOL} { --cf-seg-w: ${s(40)}; }
  /* While the composer opens or closes, its button row is pinned to the bottom-right corner, so the buttons ride
     with the growing (or shrinking) bottom edge into the two-row (or one-line) place, instead of jumping there
     when bb switches layouts at the end (kayg: "buttons only shift to the bottom row once both expansions are
     done"). bb's two-row layout puts the row at that same corner, so the hand-over is seamless. */
  ${C}:is([data-cf-opening], [data-cf-closing]) form[data-promptbox] [data-promptbox-action-row] {
    position: absolute;
    right: 0; /* the row carries the side inset as its own padding (pinned 8pt in, it shifted 8pt) */
    bottom: 0;
    z-index: 1;
  }
  /* The one-line row has no bottom padding (the two-row one does): it needs the inset itself. */
  ${C}[data-cf-opening] form[data-promptbox] [data-promptbox-action-row] { bottom: var(--cf-cinset); }
  ${C}[data-cf-closing] form[data-promptbox] [data-promptbox-action-row] { left: 0; }
  /* One radius for both states: at 52pt tall, 26pt IS the capsule, so the corners never jump mid-morph. */
  ${C} form[data-promptbox] { border-radius: ${s(26)} !important; }
  ${C} [contenteditable="true"] { font-size: calc(17px * var(--cf-ui-scale, 1)) !important; }
  ${R}.dark ${C.slice(R.length + 1)} form[data-promptbox] { border-color: rgb(255 255 255 / 0.08) !important; }
  /* The model pill matches the circles' height; the composer sits on the chat text's 16pt margin. */
  ${PILL}[aria-label^="Provider, model"] { height: var(--cf-cp); }
  /* ── The focus morph, like ChatGPT's iOS composer (measured from kayg's 60fps recording, 2026-11-15):
     unfocused it is a narrower capsule (38pt from the screen edges); focused it widens to 12pt from the edges
     and grows to its two rows while it rides up with the keyboard, all in one ~350ms iOS-style ease-out, no
     step in between. Width: the box's side padding (one small element's layout per frame). Height: bb's
     own grid-rows transition, given the same duration and curve. Keyboard actions never animate
     (input-mode.ts zeroes transitions). */
  ${C} [data-composer-box] {
    padding-inline: ${s(4)};
    transition: padding-inline 350ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  ${C}:is([data-cf-collapsed]:not([data-cf-opening]), [data-cf-closing]) [data-composer-box] { padding-inline: ${s(30)}; }
  /* Strips above the composer (bb's "Running 1 background agent", the queue): kayg asked for them to match
     the composer. They sit beside [data-composer-box] in the same container, so a margin equal to the box's
     padding puts them on the composer's edges, and the same transition keeps them there through the morph.
     bb tucks an "attached" strip under the composer (-mb-5, square bottom); over our capsule that read as a
     tab, so here every strip floats one gap (bb's gap-2) above it, as a capsule (a 44pt row, radius half of it; an opened
     list keeps the 22pt corners). */
  ${C} section.bg-surface-raised-solid {
    margin-inline: ${s(4)};
    margin-bottom: 0 !important; /* bb's own gap-2 above the composer is the one gap */
    padding-bottom: 0 !important;
    min-height: ${s(44)};
    justify-content: center;
    border-radius: ${s(22)} !important;
    border-bottom-width: 1px !important;
    transition: margin-inline 350ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  ${C}:is([data-cf-collapsed]:not([data-cf-opening]), [data-cf-closing]) section.bg-surface-raised-solid { margin-inline: ${s(30)}; }
  ${C} section.bg-surface-raised-solid > :first-child { min-height: calc(${s(44)} - 2px); padding-inline: ${s(16)}; } /* 44 with the border */
  /* Its toggle: bb draws it as a pressed chip (ring, shadow, a lighter fill) inside the strip; on the capsule
     that read as a box in a box. Here the row itself is the button: no chip, 15pt text, an 18pt glyph. */
  ${C} #thread-background-commands-card-toggle {
    min-height: calc(${s(44)} - 2px);
    padding-inline: 0;
    gap: ${s(8)};
    font-size: ${s(15)};
    background: transparent !important;
    box-shadow: none !important;
  }
  ${C} #thread-background-commands-card-toggle svg { width: ${s(18)}; height: ${s(18)}; }
  /* bb's expanded placeholder is two lines long; swapping to it mid-morph reflowed the text. Keep the short
     one (only for bb's default text: other states, like "Setting up…", keep theirs). */
  ${C} p.is-editor-empty[data-placeholder^="Ask for a follow-up."]::before { content: "Ask a follow-up" !important; }
  ${C} [data-promptbox-layout] {
    transition-duration: 350ms !important;
    transition-timing-function: cubic-bezier(0.32, 0.72, 0, 1) !important;
  }
  @media (prefers-reduced-motion: reduce) {
    ${C} [data-composer-box], ${C} [data-promptbox-layout], ${C} section.bg-surface-raised-solid { transition: none !important; }
  }
  /* The keyboard-down button copies the mic's classes (touch.ts), filled colour included: it is a quiet pill. */
  ${ROW} [data-cf-kb] { background-color: var(--cf-pill-quiet) !important; color: var(--foreground) !important; }
  ${ROW} > [data-promptbox-standard-actions][data-promptbox-expanded-only] { min-width: 0; }
  ${PILL}[aria-label^="Provider, model"] { flex: 0 1 auto; min-width: var(--cf-cp); overflow: hidden; }
  ${ROW} button[aria-label^="Provider, model"] .truncate { min-width: 0; }
  ${R} [data-app-composer]:not([data-cf-keyboard]) [data-promptbox-action-row] button[aria-label^="Provider, model"] :is(.truncate, [data-promptbox-hide-compact]) { display: none; }
  ${R} [data-app-composer][data-cf-keyboard] [data-follow-up-composer-footer] { display: none !important; }
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

/* The toolbar's items (ring, permission, environment): segments, transparent until hovered. */
${TOOL} {
${SEGMENT}  --cf-tb-pill: var(--cf-tbp-c);
  background-color: transparent;
  transition: scale 150ms var(--cf-ease-out), background-color 150ms ease, color 150ms ease;
}
${TOOL} :is(svg[data-icon-root], svg) { width: var(--cf-ci) !important; height: var(--cf-ci) !important; }
${C} [data-cf-env] > * { width: 100%; height: 100%; }
${C}[data-cf-merged] [data-follow-up-composer-footer] button[aria-label^="Context window"] svg { margin: 0; }

@media (hover: hover) {
  ${PILL}:not(:disabled):hover, ${TOOL}:not(:disabled):hover { background-color: var(--cf-pill-hover); }
  ${SEND}:not(:disabled):hover { filter: brightness(1.08); }
}
${PILL}:not(:disabled):active, ${SEND}:not(:disabled):active, ${TOOL}:active { scale: 0.97; }
${TOOL}:not(:disabled):active { background-color: var(--cf-pill-hover); }
@media (prefers-reduced-motion: reduce) {
  ${PILL}, ${SEND}, ${TOOL} { transition: none; }
}
`;

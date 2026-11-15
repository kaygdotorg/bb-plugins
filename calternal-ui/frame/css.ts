/**
 * The frame's stylesheet. Calternal's frame, laid over bb's existing shell DOM, after Craft:
 *
 *   window backdrop   the wallpaper, heavily blurred and tinted: one seamless surface
 *   ├─ left sidebar   no surface of its own; sits flat on the backdrop
 *   ├─ chat card      floats on the backdrop with a gap all round: lighter glass
 *   └─ right panel    no surface of its own, like the left sidebar
 *
 * bb's own selectors this relies on (bb 0.49): `[data-testid="app-layout-root"]`
 * (sidebar wrapper; `[data-framed]` in the desktop app), `[data-sidebar=…]`,
 * `main[data-sidebar="inset"]`, and react-resizable-panels' `[data-panel-group]`
 * / `[data-panel]` inside it. Everything is gated on `html[data-calternal-ui]`
 * so removing that attribute restores bb exactly.
 */
import { BACKDROP, CARD, CARD_FALLBACK, CARD_PANEL, FLAT, GROUP, MAIN, PLAIN_MAIN, R, SHELL, SIDE_PANEL } from "./selectors";

export const CSS = `
${R} {
  --cf-bg: var(--background);
  --cf-side: var(--sidebar);
  /* Defaults; applyPrefs() overrides these on <html> from the plugin's settings. */
  --cf-side-blur: blur(12px) saturate(120%);
  --cf-side-tint: color-mix(in oklab, var(--cf-side) 50%, transparent);
  --cf-side-dim: transparent;
  --cf-card-blur: blur(75px) saturate(140%);
  --cf-card-tint: color-mix(in oklab, var(--cf-bg) 75%, transparent);
  --cf-card-dim: rgb(0 0 0 / 0.25);
  /* Interface size: bb sizes text and spacing in rem, so the root size scales both.
     The plugin's 100% is bb's 110%: bb's own 16px reads small on a glass layout. */
  font-size: calc(17.6px * var(--cf-ui-scale, 1)) !important;
  --cf-gap: 8px;
  /* The iPhone 16 Pro Max's display corner (~62pt): sheets and the sliding pane follow it. */
  --cf-device-radius: 62px;
  /* One radius scale for everything. bb derives md / lg / xl from --radius (-2, 0, +4px),
     so 10px gives controls 8, panels 10, and surfaces 14; the plugin's own surfaces (card,
     menus, popovers, desktop sheets) use that same 14. Phones are the one exception: the
     sliding pane and inset sheets follow the screen's corner (--cf-device-radius). */
  --radius: 10px;
  --cf-radius: calc(var(--radius) + 4px);
  /* Shared glass for floating panes (composer, inset sheets): one look, defined once. */
  --cf-glass-fill: color-mix(in oklab, var(--cf-bg) 38%, transparent);
  --cf-glass-blur: blur(24px) saturate(170%);
  --cf-glass-highlight: inset 0 1px 0 rgb(255 255 255 / 0.06);
  --cf-glass-shadow: 0 8px 24px -14px rgb(0 0 0 / 0.5);
  --cf-edge: rgb(255 255 255 / 0.55);
  --cf-shadow: 0 6px 14px -7px rgb(60 40 20 / 0.28);
  /* Warning text (Full Access): bb's amber is too light to read on a light
     glass, so light mode inks it darker. */
  --cf-warn-ink: oklch(0.55 0.15 50);
  background: var(--cf-side) !important;
}
${R}.dark {
  --radius: 10px;
  --cf-edge: rgb(255 255 255 / 0.09);
  --cf-warn-ink: var(--warning, oklch(0.75 0.15 70));
  /* Must stay inside --cf-gap: bb clips the center region, so a wider shadow is cut off in a straight line. */
  --cf-shadow: 0 6px 14px -7px rgb(0 0 0 / 0.55);
}
${R} body, ${R} #root, ${SHELL}, ${R} [data-app-content-shell] {
  background: transparent !important;
}

/* The window backdrop: one fixed layer under everything. */
${BACKDROP} {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}
${BACKDROP}::before {
  content: "";
  position: absolute;
  inset: -140px; /* the blur fades at its edges; keep those off-screen */
  background: var(--cf-wall, none) center / cover no-repeat;
  filter: var(--cf-side-blur);
}
${BACKDROP}::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(var(--cf-side-dim), var(--cf-side-dim)), var(--cf-side-tint);
}

/* Accent: one hue drives bb's otherwise grey palette. --cf-accent-h / -c are set by
   applyAccent(); lightness is fixed per scheme so any hue stays legible. */
${R} {
  --cf-accent: oklch(0.56 var(--cf-accent-c, 0.13) var(--cf-accent-h, 62));
  --cf-accent-fg: oklch(0.99 0.01 var(--cf-accent-h, 62));
}
${R}.dark {
  --cf-accent: oklch(0.76 var(--cf-accent-c, 0.13) var(--cf-accent-h, 62));
  --cf-accent-fg: oklch(0.2 0.03 var(--cf-accent-h, 62));
}
${R}, ${R}.dark {
  --primary: var(--cf-accent);
  --primary-foreground: var(--cf-accent-fg);
  --ring: var(--cf-accent);
  --sidebar-ring: var(--cf-accent);
  --accent: color-mix(in oklab, var(--cf-accent) 20%, transparent);
  --accent-foreground: var(--foreground);
  --sidebar-accent: color-mix(in oklab, var(--cf-accent) 18%, transparent);
  --sidebar-accent-foreground: var(--foreground);
  --surface-selected: color-mix(in oklab, var(--cf-accent) 16%, transparent);
  --surface-selected-border: color-mix(in oklab, var(--cf-accent) 45%, transparent);
  --state-hover: color-mix(in oklab, var(--cf-accent) 12%, transparent);
  --state-active: color-mix(in oklab, var(--cf-accent) 22%, transparent);
}
${R} ::selection { background-color: color-mix(in oklab, var(--cf-accent) 38%, transparent); }
${R} .ProseMirror-hideselection ::selection { background-color: transparent; }
${R} { accent-color: var(--cf-accent); caret-color: var(--cf-accent); }

${R} :is([role="menu"], [role="listbox"]) :is([role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]) {
  border-radius: calc(var(--cf-radius) - 6px) !important;
}
${R} :is([role="menu"], [role="listbox"]) [role="separator"] { margin-inline: 2px; }

/* bb's inverse controls (bg-foreground + text-background) are its primary buttons: they
   take the accent. Elsewhere text-background keeps the real background colour, which the
   card makes clear. */
${R} :is(button, a, [role="button"]).bg-foreground {
  background-color: var(--cf-accent) !important;
  color: var(--cf-accent-fg) !important;
}
${R} :is(button, a, [role="button"]).bg-foreground:hover { filter: brightness(1.06); }
${R} .text-background { color: var(--cf-bg) !important; }
/* Switches: on = accent track with a light knob; off = bb's own. */
${R} [role="switch"][data-state="checked"] { background-color: var(--cf-accent) !important; }
${R} [role="switch"][data-state="checked"] > span { background-color: var(--cf-accent-fg) !important; }
${R} [role="switch"][data-state="unchecked"] > span { background-color: var(--foreground) !important; }

/* Swipe actions (frame/swipe.ts): the row slides, an action label shows in the gap. */
${R} [data-cf-swipe-label] {
  position: absolute;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  padding: 0 1rem;
  font-size: 0.75rem;
  font-weight: 500;
  color: var(--muted-foreground);
  pointer-events: none;
  opacity: 0;
  transition: color 120ms, opacity 120ms;
}
${R} [data-cf-swipe-label][data-ready] { color: var(--cf-accent); }
${R} [data-cf-swipe-label][data-ready][data-tone="danger"] { color: var(--destructive); }
/* Your messages get an iMessage tail, in the bubble's own fill. Like iMessage: the bubble's
   right edge runs straight down (bottom-right corner square) and, over the lower half of a
   one-line bubble, flares out into a rounded point a little below it; the tail's lower edge
   sweeps back under the bubble. Units: the 14×20 viewBox is 14×20px at a 16px root; the
   bubble's right edge is x=6 and its bottom y=18. The tail never overlaps the bubble, so a
   translucent fill doesn't double. The bubble's border goes: iMessage has none. */
${R} [data-timeline-row-id*=":user-"] .rounded-xl.bg-surface-recessed {
  position: relative;
  border-color: transparent !important;
  border-bottom-right-radius: 0;
}
${R} [data-timeline-row-id*=":user-"] .rounded-xl.bg-surface-recessed::after {
  content: "";
  position: absolute;
  right: -0.5rem;      /* 8 units stick out to the right */
  bottom: -0.125rem;   /* the point hangs 2 units below */
  width: 0.875rem;
  height: 1.25rem;
  background: var(--surface-recessed);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 20'%3E%3Cpath d='M6 0C6.2 8 8.4 14 12.2 17.6C13.3 18.3 13.5 19 12.6 19.4C10 20.1 7.5 19.9 5 19C3.4 18.5 1.8 18 0 18L6 18Z'/%3E%3C/svg%3E") center / 100% 100% no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 20'%3E%3Cpath d='M6 0C6.2 8 8.4 14 12.2 17.6C13.3 18.3 13.5 19 12.6 19.4C10 20.1 7.5 19.9 5 19C3.4 18.5 1.8 18 0 18L6 18Z'/%3E%3C/svg%3E") center / 100% 100% no-repeat;
  pointer-events: none;
}

/* bb's "thread context" strip above the composer (git changed files, pull request) repeats
   what the right sidebar's info tab shows, so it is not shown in the chat. */
${R} [data-app-composer] section[aria-label="Thread context before sending"] { display: none !important; }

/* Optical spacing in compact buttons (bb's gap-1: model pill, chips, toolbar buttons). The
   boxes are evenly spaced, but a leading icon fills its box to the edge while text has side
   bearings, and a chevron's glyph sits inset in its box. So icon → text reads tighter and
   text → chevron looser than text → text; 2px either way makes all three read the same. */
${R} button.gap-1 > [data-icon-root]:first-child:not(:only-child),
${R} button.gap-1 > .contents > :has(> [data-provider-logo]):first-child { margin-inline-end: 0.125rem; }
${R} button.gap-1 > [data-icon="ChevronDown"]:last-child:not(:first-child) { margin-inline-start: -0.125rem; }

/* Sidebar footer: [usage] ···· [+] [search] [settings] […]. bb renders each item as an
   li[data-footer-item] in one flex row; only their order changes here, so bb's own overflow
   logic still works. The usage item (cliproxy-usage plugin) takes the free space's margin. */
${R} [data-sidebar="footer"] li[data-footer-item^="plugin:cliproxy-usage/"] { order: 0; margin-inline-end: auto; }
${R} [data-sidebar="footer"] li[data-footer-item="plugin:calternal-ui/new-thread"] { order: 1; }
${R} [data-sidebar="footer"] li[data-footer-item="plugin:calternal-ui/search"] { order: 2; }
${R} [data-sidebar="footer"] li[data-footer-item="builtin:settings"] { order: 3; }
${R} [data-sidebar="footer"] li[data-sidebar="menu-item"]:not([data-footer-item]) { order: 4; }

/* Strips stacked above the composer (bb's git status, plugin notices) are solid panels in
   bb; here they share the composer's glass. Text only, so a plain backdrop-filter is fine. */
${R} [data-app-composer] section.bg-surface-raised-solid {
  background: var(--cf-glass-fill) !important;
  -webkit-backdrop-filter: var(--cf-glass-blur);
  backdrop-filter: var(--cf-glass-blur);
  border-color: color-mix(in oklab, var(--foreground) 10%, transparent) !important;
}
/* Mention pills (thread titles, prompts): a faint tint instead of a solid white chip. */
${R} .prompt-mention-pill { background: color-mix(in oklab, var(--foreground) 7%, transparent) !important; border-color: color-mix(in oklab, var(--foreground) 10%, transparent) !important; }

/* Composer (frame/composer.ts): bb's row under the composer is pinned into its bottom row,
   right after the model button, as icons; collapsed composers show one line only. */
${R} [data-app-composer][data-cf-merged] [data-follow-up-composer-footer] {
  position: absolute;
  left: var(--cf-foot-x);
  top: var(--cf-foot-y);
  height: var(--cf-foot-h);
  margin: 0 !important;
  padding: 0 !important; /* bb pads this row 15px; the icons' own boxes do the spacing */
  min-height: 0 !important;
  max-height: none !important;
  width: auto !important;
  max-width: var(--cf-foot-w, none);
  overflow: hidden;
  z-index: 25;
  display: flex;
  align-items: center;
  gap: 0; /* each icon is a 2rem box: glyph gaps come out at 1rem, like + → model */
}
${R} [data-app-composer][data-cf-merged] [data-follow-up-composer-footer] > div { display: contents; }
${R} [data-app-composer][data-cf-merged] [data-follow-up-composer-footer] :is([data-promptbox-hide-branch-compact], button[aria-label="New thread in this environment"]) { display: none !important; }
/* Order: context ring, permission, environment. */
${R} [data-app-composer][data-cf-merged] button[aria-label^="Context window"] { order: 1; }
${R} [data-app-composer][data-cf-merged] button[aria-label="Permission mode"] { order: 2; }
${R} [data-app-composer][data-cf-merged] :is([data-cf-env], button[aria-label^="Thread details"]) { order: 3; }
/* Phones show "Thread details: <branch>" instead of the environment: the branch icon only. */
${R} [data-app-composer][data-cf-merged] button[aria-label^="Thread details"] { width: 2rem; height: 2rem; padding: 0 !important; justify-content: center; gap: 0 !important; color: var(--muted-foreground); }
${R} [data-app-composer][data-cf-merged] button[aria-label^="Thread details"] > span { display: none !important; }
/* Environment: the folder icon only; the name and branch live in its tooltip. */
${R} [data-app-composer][data-cf-merged] [data-cf-env] [data-option-display] { display: none !important; }
${R} [data-app-composer][data-cf-merged] [data-cf-env] { width: 2rem; height: 2rem; padding: 0 !important; justify-content: center; color: var(--muted-foreground); }
${R} [data-app-composer][data-cf-merged] [data-cf-env] > * { justify-content: center; padding: 0 !important; margin: 0 !important; }
/* Permission: an icon per mode instead of the label and chevron; Full Access in amber. */
${R} [data-app-composer][data-cf-merged] button[aria-label="Permission mode"] { width: 2rem; height: 2rem; padding: 0 !important; justify-content: center; gap: 0 !important; color: var(--muted-foreground); }
${R} [data-app-composer][data-cf-merged] button[aria-label="Permission mode"] > * { display: none !important; }
${R} [data-app-composer][data-cf-merged] button[aria-label="Permission mode"]::before {
  content: "";
  width: 1rem;
  height: 1rem;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z'/%3E%3C/svg%3E") center / contain no-repeat;
}
${R} [data-app-composer][data-cf-merged] button[data-cf-perm="edit"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z'/%3E%3C/svg%3E"); }
${R} [data-app-composer][data-cf-merged] button[data-cf-perm="plan"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z'/%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z'/%3E%3Ccircle cx='12' cy='12' r='3'/%3E%3C/svg%3E"); }
${R} [data-app-composer][data-cf-merged] button[data-cf-perm="full"]::before { -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='11' x='3' y='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 9.9-1'/%3E%3C/svg%3E"); mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Crect width='18' height='11' x='3' y='11' rx='2'/%3E%3Cpath d='M7 11V7a5 5 0 0 1 9.9-1'/%3E%3C/svg%3E"); }
${R} [data-app-composer][data-cf-merged] button[data-cf-perm="full"] { color: var(--cf-warn-ink); }
/* Context ring: the percentage only when it's nearly full. */
${R} [data-app-composer][data-cf-merged] button[aria-label^="Context window"] span { display: none !important; }
${R} [data-app-composer][data-cf-merged] button[aria-label^="Context window"][data-cf-hot] span { display: inline !important; margin-inline-end: 0.25rem; }
${R} [data-app-composer][data-cf-merged] button[aria-label^="Context window"] { width: 2rem; height: 2rem; margin: 0 !important; padding: 0 !important; justify-content: center; }
${R} [data-app-composer][data-cf-merged] button[aria-label^="Context window"][data-cf-hot] { width: auto; gap: 0.375rem !important; padding-inline: 0.5rem !important; }
/* "New thread here", added to the + menu after it opened: one line like its neighbours. */
${R} [data-cf-new-thread] { white-space: nowrap; }
${R} [role="menu"]:has(> [data-cf-new-thread]) { width: max-content !important; max-width: none !important; }
/* Collapsed: one line, no row under it. */
${R} [data-app-composer][data-cf-collapsed] [data-follow-up-composer-footer] { display: none !important; }
${R} [data-cf-model-chip] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border-radius: calc(var(--radius) - 2px);
  color: var(--muted-foreground);
  background: transparent;
  border: 0;
}
${R} [data-cf-model-chip] > * { width: 1rem; height: 1rem; }

/* Voice input (frame/voice.ts). While bb records, the merged icon row steps aside (it was
   drawn over the waveform), and the waveform becomes an accent-tinted pill that grows out
   of the mic's side, with an elapsed clock at its end. bb paints the bars in the canvas's
   CSS colour. */
${R} [data-app-composer][data-cf-voice] [data-follow-up-composer-footer] { display: none !important; }
${R} [data-cf-voice-pill] {
  height: 2rem;
  gap: 0.5rem;
  padding-inline: 0.875rem 0.75rem;
  border-radius: 999px;
  background: color-mix(in oklab, var(--cf-accent) 18%, transparent);
  color: color-mix(in oklab, var(--cf-accent) 55%, var(--foreground));
  transform-origin: right center;
  animation: cf-voice-pill-in 260ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
}
${R} [data-cf-voice-pill] canvas { color: inherit; }
${R} [data-cf-voice-pill] > :first-child { min-width: 0; flex: 1; height: 1.25rem; } /* bars keep clear of the pill edge */
${R} [data-cf-voice-clock] {
  flex: none;
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
  color: color-mix(in oklab, var(--cf-accent) 45%, var(--foreground));
}
${R} [data-app-composer][data-cf-voice="transcribing"] [data-cf-voice-pill] { background: color-mix(in oklab, var(--cf-accent) 10%, transparent); }
${R} [data-app-composer][data-cf-voice="transcribing"] [data-cf-voice-clock] { opacity: 0.6; }
@keyframes cf-voice-pill-in {
  from { transform: scaleX(0.15); opacity: 0; }
  60% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  ${R} [data-cf-voice-pill] { animation: none; }
}
/* A failed recording: bb draws a solid grey slab with a grey Retry. Here it's a faint tint
   on the glass, with Retry in the accent like other primary-ish actions. */
${R} [data-promptbox-failed-voice-recordings] > [role="group"] {
  background: color-mix(in oklab, var(--foreground) 6%, transparent) !important;
  border-radius: var(--cf-radius);
}
${R} [data-promptbox-failed-voice-recordings] button.bg-secondary {
  background: color-mix(in oklab, var(--cf-accent) 22%, transparent) !important;
  color: var(--foreground);
}

/* Keyboard-down button in the composer's submit group (frame/touch.ts): only while the keyboard is up. */
${R} [data-cf-kb] { display: none; }
${R}[data-cf-keyboard] [data-cf-kb] { display: inline-flex; }

/* Times revealed by a right-to-left swipe on the chat (frame/swipe.ts): one fixed layer
   over the chat, labels at its right edge, uncovered as the conversation slides left. */
${R} [data-cf-time-layer] { position: fixed; inset: 0; pointer-events: none; z-index: 40; }
${R} [data-cf-time] {
  position: absolute;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--muted-foreground);
  opacity: 0;
  white-space: nowrap;
  transition: opacity 160ms;
}

/* Context menus opened by a swipe to run an action stay invisible. */
${R}[data-cf-silent-menu] :is([role="menu"], [data-persistent-drawer-content], [data-persistent-drawer-backdrop]) { opacity: 0 !important; }

/* Menus, popovers, context menus: frosted and tinted, not flat grey. */
/* Warm tooltips (frame/tooltip.ts): one warm cream surface for the whole app. bb's own
   tooltips are hidden so they never double up. */
${R} [data-radix-popper-content-wrapper]:has([role="tooltip"]) { display: none !important; }
${R} [data-cf-tip] {
  /* The accent, mixed into the theme's surface: tooltips follow the wallpaper or custom colour. */
  --cf-tip-surface: color-mix(in oklab, var(--cf-accent) 22%, var(--cf-side));
  --cf-tip-ink: var(--foreground);
  position: fixed;
  left: 0;
  top: 0;
  z-index: 1000;
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  max-width: min(22rem, calc(100vw - 16px));
  padding: 0.375rem 0.625rem;
  border-radius: calc(var(--radius) - 2px);
  background: var(--cf-tip-surface);
  color: var(--cf-tip-ink);
  font: 500 0.75rem/1.3 var(--font-sans);
  box-shadow: 0 6px 18px -8px rgb(0 0 0 / 0.45);
  pointer-events: none;
  opacity: 0;
  scale: 0.94;
  filter: blur(4px);
  transform-origin: center bottom;
  transition: opacity 160ms cubic-bezier(0.23, 1, 0.32, 1), scale 160ms cubic-bezier(0.23, 1, 0.32, 1), filter 160ms cubic-bezier(0.23, 1, 0.32, 1);
}
${R}.dark [data-cf-tip] { box-shadow: 0 0 0 1px rgb(255 255 255 / 0.06), 0 6px 18px -8px rgb(0 0 0 / 0.6); }
${R} [data-cf-tip][data-side="bottom"] { transform-origin: center top; }
${R} [data-cf-tip]:is([data-state="open"], [data-state="open-instant"]) { opacity: 1; scale: 1; filter: none; }
${R} [data-cf-tip][data-state="open-instant"] { transition-duration: 60ms; }
/* While warm, an open tooltip glides to the next trigger instead of popping again. */
${R} [data-cf-tip][data-glide="true"] { transition: translate 140ms cubic-bezier(0.23, 1, 0.32, 1), opacity 60ms; }
${R} [data-cf-tip] kbd {
  font: 500 0.6875rem/1 var(--font-sans);
  padding: 0.125rem 0.3rem;
  border-radius: 0.25rem;
  background: color-mix(in oklab, var(--cf-tip-ink) 10%, transparent);
  color: color-mix(in oklab, var(--cf-tip-ink) 70%, transparent);
}
${R} [data-cf-tip] i {
  position: absolute;
  width: 8px;
  height: 8px;
  margin-left: -4px;
  background: var(--cf-tip-surface);
  rotate: 45deg;
  bottom: -4px;
}
${R} [data-cf-tip][data-side="bottom"] i { bottom: auto; top: -4px; }
@media (prefers-reduced-motion: reduce) {
  ${R} [data-cf-tip] { scale: 1; filter: none; transition: opacity 80ms; }
}

/* Every floating menu (context menus, dropdowns, drop-ups, pickers) gets the same glass as the
   context menu; panels inside them go clear so it reads as one surface. */
${R} :is([role="menu"], [role="listbox"], [data-radix-popper-content-wrapper] > [data-state]) :is(.bg-popover, .bg-card, .bg-background, .bg-muted, .bg-surface-raised, .bg-surface-recessed, .bg-surface-raised-solid) {
  background-color: transparent !important;
}
${R} :is([role="menu"], [role="listbox"], [data-radix-popper-content-wrapper] > [data-state]) {
  /* Concentric corners: outer radius = item radius + padding (14 = 8 + 6). */
  border-radius: var(--cf-radius) !important;
  padding: 6px !important;
  /* Hover and highlight inside menus read as the accent, not grey. */
  --state-hover: color-mix(in oklab, var(--cf-accent) 26%, transparent);
  --accent: color-mix(in oklab, var(--cf-accent) 26%, transparent);
  background-color: color-mix(in oklab, var(--popover) 80%, transparent) !important;
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  backdrop-filter: blur(24px) saturate(160%);
  border-color: color-mix(in oklab, var(--foreground) 10%, transparent) !important;
}

/* A list inside a menu, picker or dialog (the model picker's list, the palette's results) is
   part of that one surface: no second glass layer, border or padding ring. */
${R} :is([role="menu"], [role="listbox"], [data-radix-popper-content-wrapper] > [data-state], [role="dialog"][data-bb-portaled-overlay]) :is([role="menu"], [role="listbox"]) {
  background-color: transparent !important;
  -webkit-backdrop-filter: none;
  backdrop-filter: none;
  border-color: transparent !important;
  padding: 0.25rem !important;
}
/* Modal dialogs (the search palette, confirmations) float like menus: the same glass, with
   their inner bands clear. Outside the card, bg-background would be opaque. Phone sheets
   ([data-persistent-drawer-content]) keep their own glass. */
${R} [role="dialog"][data-bb-portaled-overlay]:not([data-persistent-drawer-content]):is(.bg-background, .bg-popover, .bg-card) {
  background-color: color-mix(in oklab, var(--popover) 80%, transparent) !important;
  -webkit-backdrop-filter: blur(24px) saturate(160%);
  backdrop-filter: blur(24px) saturate(160%);
  border-color: color-mix(in oklab, var(--foreground) 10%, transparent) !important;
}
${R} [role="dialog"][data-bb-portaled-overlay] :is(.bg-background, .bg-popover, .bg-card, [data-palette-input-band], [data-palette-results-clip]) {
  background-color: transparent !important;
}

@media (min-width: 768px) {
  /* Desktop app: drop bb's recessed window frame; the backdrop is the frame now. */
  ${SHELL}[data-framed] {
    padding: 0 !important;
    background-image: none !important;
    --bb-window-frame-top: 0px;
    --bb-window-frame-lip: 0px;
    --bb-window-frame-leading-lip: 0px;
  }
  ${SHELL} [data-sidebar="panel"] {
    background: transparent !important;
    border-right-width: 0 !important;
  }

  /* Sidebars: no fill, no edge. They sit flat on the backdrop. */
  ${FLAT} {
    --sidebar: transparent;
    --background: transparent;
    --surface-scrim: transparent;
    background: transparent !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
    border-left-width: 0 !important;
  }
  :is(${SIDE_PANEL}) aside { border-left-width: 0 !important; }
  /* bb's collapsed icon rail (its own navigation, placement=rail) sits flat on the backdrop too. */
  ${SHELL} [data-sidebar-navigation-placement="rail"] {
    background: transparent !important;
    border-color: transparent !important;
    box-shadow: none !important;
  }

  /* The center region is see-through; only the chat card inside it paints. */
  ${MAIN} {
    --background: transparent;
    background: transparent !important;
    mask-image: none !important;
    -webkit-mask-image: none !important;
    clip-path: none !important;
    margin-top: 0 !important;
    height: 100% !important;
    padding: 0 !important;
  }
  ${MAIN}::before, ${MAIN}::after { content: none !important; }
  /* Page headers (Plugins' "Plugins / Browse" row) sit flat on the backdrop, like
     Craft's tab row. No seams under them. */
  ${MAIN} { --surface-scrim: transparent; }
  ${MAIN} header { background: transparent !important; border-bottom-color: transparent !important; }
  ${SHELL} [data-sidebar="inset-edge"] { display: none !important; }
  ${GROUP} > [data-resize-handle] { background: transparent !important; }

  /* Only while collapsed (expanded, it lines up with the sidebar's own row): bb pins its toggle to the window's top-left for a card
     that starts at (0,0). Ours floats one gap (+1px border) in, so the toggle follows. */
  ${R}:has([data-side="left"][data-state="collapsed"]) [data-testid="app-sidebar-trigger-overlay"],
  ${R}:has([data-side="left"][data-state="collapsed"]) [data-testid="app-desktop-sidebar-trigger"] {
    translate: calc(var(--cf-gap) + 1px) 0; /* + the card's 1px side border */
  }

  /* Resize handles: no seam lines. A small grip pill appears on hover only. */
  ${SHELL} [data-testid="app-sidebar-resize-handle"]::before,
  ${GROUP} > [data-resize-handle] span.w-px {
    top: 50% !important;
    bottom: auto !important;
    height: 36px !important;
    width: 4px !important;
    border-radius: 999px;
    translate: 0 -50%;
    background: transparent !important;
    transition: background-color 120ms ease-out;
  }
  ${GROUP} > [data-resize-handle] span.w-px { margin-left: -2px; }
  ${SHELL} [data-testid="app-sidebar-resize-handle"]:hover::before,
  ${GROUP} > [data-resize-handle]:hover span.w-px,
  ${GROUP} > [data-resize-handle][data-resize-handle-state="drag"] span.w-px {
    background: color-mix(in oklab, var(--foreground) 32%, transparent) !important;
  }

  /* The chat card floats with a gap all round. Its glass is two layers of its own
     (the wallpaper, blurred; then a tint), not a backdrop-filter on the card: that
     would make the card a backdrop root, and the composer inside could then never
     blur through to the wallpaper (calternal point 34). */
  ${CARD} {
    --surface-scrim: transparent;
    position: relative;
    isolation: isolate;
    /* Flush with the window's top and bottom; the gap separates it from the sidebars only.
       No top/bottom border there: the edge colour is translucent and the glass layers sit
       inside the border box, so a border at the window edge showed a strip of wallpaper. */
    margin: 0 var(--cf-gap);
    background: transparent !important;
    border: 1px solid var(--cf-edge);
    border-block-width: 0;
    /* The same corner as the phone pane (the screen's, ~62pt), squircle where supported. */
    border-radius: var(--cf-device-radius);
    corner-shape: squircle;
    box-shadow: var(--cf-shadow);
    overflow: clip !important;
  }
  ${PLAIN_MAIN} { padding: 0 var(--cf-gap) !important; }
  ${CARD_FALLBACK} { margin: 0 !important; }
  :is(${CARD})::before {
    content: "";
    position: absolute;
    inset: -160px; /* > 2 × the largest blur: a blur fades its own edges to transparent */
    z-index: -2;
    pointer-events: none;
    /* fixed: lines the card's copy of the wallpaper up with the window's. */
    background: var(--cf-wall, none) center / cover no-repeat fixed;
    filter: var(--cf-card-blur);
  }
  :is(${CARD})::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: linear-gradient(var(--cf-card-dim), var(--cf-card-dim)), var(--cf-card-tint);
  }
}

@media (min-width: 768px) {${cardInterior(`:is(${CARD})`)}}

/* Phones: bb's main pane is full-screen and slides aside to reveal the sidebar drawer
   beneath it. The pane becomes edge-to-edge glass (its layers are opaque, so it still
   covers the drawer); the drawer and its contents sit flat on the backdrop. */
@media (max-width: 767px) {
  ${R} { font-size: calc(16px * var(--cf-ui-scale, 1)) !important; }
  ${SHELL} [data-sidebar="panel"], ${FLAT} {
    --sidebar: transparent;
    background: transparent !important;
    border-color: transparent !important;
  }
  ${MAIN} {
    --background: transparent;
    /* Solid base under the glass: the pane must hide the drawer beneath it completely. */
    background: var(--cf-side) !important;
    isolation: isolate;
    overflow: clip;
    transition: border-radius 220ms cubic-bezier(0.32, 0.72, 0, 1), box-shadow 220ms ease-out;
  }
  /* At rest the pane is a full-screen sheet. When it slides aside for the drawer or the
     right panel, it becomes the floating card: rounded, with the card's edge and shadow. */
  ${MAIN}:is([data-sidebar-shelf]:not([data-sidebar-shelf="closed"]), [data-panel-shelf]:not([data-panel-shelf="closed"])) {
    /* Like Claude's iOS app: the pane takes the screen's own corner radius, so it reads as
       the display itself sliding aside. Squircle corners where supported (Chromium). */
    border-radius: var(--cf-device-radius);
    corner-shape: squircle;
    box-shadow: 0 0 0 1px var(--cf-edge), 0 18px 48px -12px rgb(0 0 0 / 0.55);
  }
  ${MAIN}::before {
    content: "";
    position: absolute;
    inset: -160px; /* > 2 × the largest blur: a blur fades its own edges to transparent */
    z-index: -2;
    pointer-events: none;
    background: var(--cf-side) var(--cf-wall, none) center / cover no-repeat;
    filter: var(--cf-card-blur);
  }
  ${MAIN}::after {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background: linear-gradient(var(--cf-card-dim), var(--cf-card-dim)), var(--cf-card-tint);
  }
  ${MAIN} header { background: transparent !important; border-bottom-color: transparent !important; }
  /* The right panel is a shelf overlaying the pane: heavy frost so the chat stays legible behind it. */
  ${R} [data-testid="secondary-panel-shelf"] {
    --sidebar: transparent;
    --background: transparent;
    background: color-mix(in oklab, var(--cf-side) 72%, transparent) !important;
    -webkit-backdrop-filter: blur(40px) saturate(140%);
    backdrop-filter: blur(40px) saturate(140%);
    border-left-color: transparent !important;
  }
  /* Search palette (bb's persistent drawer): an inset sheet whose corners are concentric
     with the screen's. --cf-device-radius is the iPhone 16 Pro Max display radius (~62pt);
     sheet radius = device radius - inset. Frosted like the menus. */
  ${R} [data-persistent-drawer-content] {
    --cf-sheet-inset: 8px;
    --background: transparent;
    left: var(--cf-sheet-inset) !important;
    right: var(--cf-sheet-inset) !important;
    margin-bottom: var(--cf-sheet-inset);
    border-radius: calc(var(--cf-device-radius) - var(--cf-sheet-inset)) !important;
    border-color: var(--cf-edge) !important;
    overflow: clip;
    background: var(--cf-glass-fill) !important;
    -webkit-backdrop-filter: var(--cf-glass-blur);
    backdrop-filter: var(--cf-glass-blur);
    box-shadow: var(--cf-glass-highlight), var(--cf-glass-shadow), 0 18px 50px -12px rgb(0 0 0 / 0.5) !important;
    padding-bottom: max(0px, calc(var(--bb-safe-area-bottom, env(safe-area-inset-bottom)) - var(--cf-sheet-inset))) !important;
  }
  ${R} [data-persistent-drawer-content] [data-palette-input-band] { background: transparent !important; padding-top: 0.5rem; }
  /* Inside the sheet everything is clear: the sheet is the one glass layer. Its results
     list is a listbox, which the menu rule would otherwise give its own fill and blur. */
  ${R} [data-persistent-drawer-content] :is([role="listbox"], [data-palette-results-viewport]) {
    background: transparent !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
  }
  /* A lighter scrim, so the glass has something to show. */
  ${R} [data-persistent-drawer-backdrop] { background: rgb(0 0 0 / 0.22) !important; }
  /* Short visible area (keyboard up): the sidebar scrolls as one column so the thread
     list keeps its rows instead of being squeezed to nothing. Set by frame/touch.ts. */
  ${R}[data-cf-short] [data-testid="app-layout-root"] [data-sidebar="sidebar"] { overflow-y: auto; }
  ${R}[data-cf-short] [data-testid="app-layout-root"] [data-sidebar="sidebar"] [data-sidebar="content"] { flex: 0 0 auto; min-height: auto; overflow: visible; }
  /* Pull-down-to-search pill (frame/touch.ts). */
  ${R} [data-cf-pull] {
    position: absolute;
    top: 0.5rem;
    left: 50%;
    translate: -50% -110%;
    padding: 0.25rem 0.75rem;
    border-radius: 999px;
    font-size: 0.75rem;
    color: var(--muted-foreground);
    background: var(--cf-glass-fill);
    -webkit-backdrop-filter: var(--cf-glass-blur);
    backdrop-filter: var(--cf-glass-blur);
    box-shadow: 0 0 0 1px var(--cf-edge), var(--cf-glass-shadow);
    opacity: 0;
    pointer-events: none;
    z-index: 20;
  }
  ${R} [data-cf-pull]::after { content: "Pull to search"; }
  ${R} [data-cf-pull][data-state="ready"] { color: var(--cf-accent); }
  ${R} [data-cf-pull][data-state="ready"]::after { content: "Release to search"; }
  /* While typing (keyboard up), the composer stays small enough to keep the chat in view:
     attachments are a chip (attachments.ts), and the text area is capped to a share of the visible height
     (--cf-vvh is the visual viewport height, set by frame/touch.ts). */
  ${R}[data-cf-keyboard] [data-promptbox-editor-scroll] { max-height: calc(var(--cf-vvh, 100dvh) * 0.28) !important; }
  /* Composer attachments on phones (frame/attachments.ts): bb's grid collapses into a chip
     in the button row; open, the grid becomes one horizontal swipeable strip. */
  ${R} [data-app-composer][data-cf-attach="collapsed"] [data-cf-attach-strip] { display: none !important; }
  ${R} [data-app-composer][data-cf-attach="open"] [data-cf-attach-strip] {
    flex-wrap: nowrap !important;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    padding-bottom: 0.125rem;
  }
  ${R} [data-app-composer][data-cf-attach="open"] [data-cf-attach-strip] > * { flex: none; scroll-snap-align: start; }
  ${R} [data-app-composer][data-cf-attach="open"] [data-cf-attach-strip] img { height: 2.75rem; width: 4rem; }
  ${R} [data-cf-attach-chip] {
    margin-inline: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    height: 1.75rem;
    padding: 0 0.5rem 0 0.25rem;
    border-radius: 999px;
    border: 1px solid var(--cf-edge);
    background: color-mix(in oklab, var(--foreground) 6%, transparent);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    color: var(--muted-foreground);
  }
  ${R} [data-cf-attach-chip] img {
    height: 1.25rem;
    width: 1.25rem;
    border-radius: 0.3rem;
    object-fit: cover;
    box-shadow: 0 0 0 1.5px var(--cf-bg);
  }
  ${R} [data-cf-attach-chip] img + img { margin-left: -0.6rem; }
  ${R} [data-cf-attach-chip][aria-expanded="true"] { color: var(--cf-accent); border-color: color-mix(in oklab, var(--cf-accent) 45%, transparent); }
  /* Touch: the compact nav rows match bb's own touch row height. */
  @media (pointer: coarse) {
    ${R} [data-cf-nav] > button { height: 2.25rem; font-size: 0.875rem; }
  }
${cardInterior(MAIN)}}
`;

/**
 * Everything inside the chat pane: floating header with its frost, the composer's frosted
 * band and pane, glass panels. Shared by the desktop card and the full-screen mobile pane.
 */
function cardInterior(scope: string): string {
  return `
  /* bb's own panels inside the card (settings groups, skill tiles) become faint glass. */
  ${scope} { --card: color-mix(in oklab, var(--foreground) 4.5%, transparent); --surface-scrim: transparent; }
  ${scope} header { border-bottom-color: transparent !important; }

  /* Chat scroll edges: text fades out under the header and frosts away behind the composer,
     instead of stopping at a hard line or showing through the clear composer footer. */
  /* The page header floats over its scroll area instead of sitting in a band above it:
     content scrolls up under the title and fades out gradually across the header's
     whole height. bb's own header row height drives the padding and the fade. */
  ${scope} :has(> header + * [data-page-scroll-viewport]) { position: relative; }
  ${scope} header:has(+ * [data-page-scroll-viewport]) {
    position: absolute !important;
    inset: 0 0 auto 0;
    z-index: 15;
    pointer-events: none;
  }
  ${scope} header:has(+ * [data-page-scroll-viewport]) > * { pointer-events: auto; }
  /* Text sliding under the title fades out behind a short plain colour gradient, only as
     tall as the title row. No blur: a masked backdrop blur rendered as a frosted block with a
     hard edge in some Chromium builds. */
  ${scope} header:has(+ * [data-page-scroll-viewport])::before {
    content: "";
    position: absolute;
    inset: 0 0 -0.75rem 0;
    z-index: -1;
    pointer-events: none;
    background: linear-gradient(to bottom, color-mix(in oklab, var(--cf-bg) 80%, transparent) 0%, color-mix(in oklab, var(--cf-bg) 55%, transparent) 55%, transparent 100%);
  }
  ${scope} header + * [data-page-scroll-viewport] {
    padding-top: var(--bb-app-chrome-row-height, 3rem);
    scroll-padding-top: var(--bb-app-chrome-row-height, 3rem);
  }
  ${scope} [data-scroll-footer] { background: transparent !important; }
  /* bb's own fade above the composer blends into --background, which is clear here. */
  ${scope} [data-overflow-fade] { display: none !important; }

  /* The composer: its own frosted pane, blurring the chat and wallpaper under it. */
  /* The glass lives on its own ::before layer, behind the content: with backdrop-filter on
     the form itself, Chromium re-composited everything inside (attachment thumbnails too)
     on every keystroke, and images flickered while typing. */
  ${scope} form[data-promptbox] {
    /* No isolation here: it would make the form a backdrop root, and the glass layer
       below would blur nothing. */
    background: transparent !important;
    border-color: var(--cf-edge) !important;
    box-shadow: var(--cf-glass-highlight), var(--cf-glass-shadow) !important;
  }
  ${scope} form[data-promptbox]::before {
    content: "";
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    pointer-events: none;
    background: var(--cf-glass-fill);
    -webkit-backdrop-filter: var(--cf-glass-blur);
    backdrop-filter: var(--cf-glass-blur);
  }
`;
}

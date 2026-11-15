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
import { PILL_CSS } from "./pills";
import { PILL_SIDEBAR_CSS } from "./pills-sidebar";
import { PILL_COMPOSER_CSS } from "./pills-composer";
import { PILL_PHONE_CSS } from "./pills-phone";
import { TITLE_PILL_CSS } from "./title-pill";
import { PILL_SETTINGS_CSS } from "./pills-settings";
import { PHONE_MENU_CSS } from "./phone-menu";
import { edgeFadeCSS } from "./edge-fade";
import { BACKDROP, CARD, CARD_FALLBACK, CARD_PANEL, FLAT, GROUP, MAIN, PLAIN_MAIN, R, SHELL, SIDE_PANEL, SIDEBAR } from "./selectors";

export const CSS = `
${R} {
  --cf-bg: var(--background);
  --cf-side: var(--sidebar);
  /* Defaults; applyPrefs() overrides these on <html> from the plugin's settings. */
  --cf-side-blur: blur(12px) saturate(120%);
  --cf-side-tint: color-mix(in oklab, var(--cf-side) 50%, transparent);
  /* "Dim" deepens a surface toward the theme: black in dark mode, white in light mode (a
     black wash over a light card made it muddy grey). applyPrefs() sets only the strength. */
  --cf-dim-rgb: 255 255 255;
  --cf-side-dim-a: 0;
  --cf-card-dim-a: 0.3;
  --cf-side-dim: rgb(var(--cf-dim-rgb) / var(--cf-side-dim-a));
  --cf-card-blur: blur(75px) saturate(140%);
  --cf-card-tint: color-mix(in oklab, var(--cf-bg) 75%, transparent);
  --cf-card-dim: rgb(var(--cf-dim-rgb) / var(--cf-card-dim-a));
  /* Interface size: bb sizes text and spacing in rem, so the root size scales both.
     The plugin's 100% is bb's 110%: bb's own 16px reads small on a glass layout. */
  font-size: calc(17.6px * var(--cf-ui-scale, 1)) !important;
  /* Side gap between the sidebars and the card: room for its shadow (bb clips beyond it). */
  --cf-gap: 12px;
  /* Motion (Emil Kowalski's practical animation tips): one strong ease-out for anything that
     enters, leaves or responds; UI motion stays under 300ms; nothing grows from a tiny scale. */
  --cf-ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  /* The iPhone 16 Pro Max's display corner (~62pt): sheets and the sliding pane follow it. */
  --cf-device-radius: 62px;
  /* One radius scale for everything. bb derives md / lg / xl from --radius (-2, 0, +4px),
     so 10px gives controls 8, panels 10, and surfaces 14; the plugin's own surfaces (card,
     menus, popovers, desktop sheets) use that same 14. Phones are the one exception: the
     sliding pane and inset sheets follow the screen's corner (--cf-device-radius). */
  --radius: 10px;
  --cf-radius: calc(var(--radius) + 4px);
  /* ONE glass for every floating surface: pills, the composer and the strips above it, menus and dialogs,
     sheets, tooltips, toasts (kayg: the same transparency + blur everywhere; iOS's liquid glass can't be done
     on the web). No tint (no grey cast): only blur, saturation and a luminance shift of what is behind,
     brighter in light, darker in dark, which keeps words on the glass legible. Change it here only. */
  --cf-glass: blur(16px) saturate(180%) brightness(1.12);
  --cf-glass-fill: transparent;
  --cf-glass-blur: var(--cf-glass);
  --cf-glass-highlight: inset 0 1px 0 rgb(255 255 255 / 0.06);
  --cf-glass-shadow: 0 8px 24px -14px rgb(0 0 0 / 0.5);
  --cf-edge: rgb(255 255 255 / 0.55);
  /* The card floats: a tight contact shadow plus a soft wide one. Its blur minus spread
     reaches exactly --cf-gap (12px), so bb's clipping never cuts it in a straight line. */
  --cf-shadow: 0 1px 3px rgb(60 40 20 / 0.16), 0 8px 20px -8px rgb(60 40 20 / 0.34);
  /* Warning text (Full Access): bb's amber is too light to read on a light
     glass, so light mode inks it darker. */
  --cf-warn-ink: oklch(0.43 0.13 45);
  background: var(--cf-side) !important;
}
/* Light mode: a light card must stay light whatever the wallpaper; with a dark wallpaper the
   ~10% still showing through turned it grey (and the title fade, a near-white gradient,
   then read as a white band). The white wash is stronger here: 30% dim -> 65% wash, so the
   wallpaper contributes ~5%. Dark mode keeps the plain strength. */
${R}:not(.dark) {
  --cf-card-dim: rgb(255 255 255 / min(0.9, calc(var(--cf-card-dim-a) * 1.5 + 0.2)));
  /* The sidebars too: over a dark wallpaper a 35% light tint is mid-grey, where neither dark
     nor light text reads (measured 2.3–2.7:1). A 50% white wash keeps them light (>= 4.5:1). */
  --cf-side-wash: rgb(255 255 255 / 0.5);
}
${R}.dark {
  --radius: 10px;
  --cf-dim-rgb: 0 0 0;
  --cf-edge: rgb(255 255 255 / 0.09);
  --cf-warn-ink: oklch(0.8 0.14 70); /* small text: bb's --warning measured 3.9:1 */
  /* bb's muted text on the dark card measured 4.4:1 (tool summaries); lift it to ~5:1. */
  --cf-card-muted: oklch(0.74 0 0);
  /* Must stay inside --cf-gap: bb clips the center region, so a wider shadow is cut off in a straight line. */
  --cf-shadow: 0 1px 3px rgb(0 0 0 / 0.4), 0 8px 20px -8px rgb(0 0 0 / 0.75);
}
/* Light mode: the sidebars sit on a bright, colourful wallpaper with only a light tint, so
   bb's mid-grey secondary text is too faint there. Ink it darker (dark mode needs nothing). */
${R}:not(.dark) :is([data-sidebar="sidebar"], ${SIDE_PANEL}) {
  --muted-foreground: oklch(0.4 0 0); /* section labels: measured 2.5:1 at bb's grey */
  --sidebar-foreground: var(--foreground);
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
  /* The pre-blurred wallpaper (frame/preblur.ts) when ready: no live filter then. */
  background: var(--cf-wall-side, var(--cf-wall, none)) center / cover no-repeat;
  filter: var(--cf-side-filter, var(--cf-side-blur));
}
${BACKDROP}::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(var(--cf-side-wash, transparent), var(--cf-side-wash, transparent)), linear-gradient(var(--cf-side-dim), var(--cf-side-dim)), var(--cf-side-tint);
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
/* The sidebar scrolls as ONE column (kayg): the nav and the thread list together, with only the wordmark row
   pinned at the top and the footer at the bottom, both floating over the rows, which fade progressively as
   they pass under either bar (edge-fade.ts). bb's own layout scrolls only the thread list and pins its
   section labels (sticky), which, on our transparent sidebar, let rows show through the labels. */
${R} [data-sidebar="sidebar"] [data-testid="app-sidebar-body"] { overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
${R} [data-sidebar="sidebar"] [data-testid="app-sidebar-body"]::-webkit-scrollbar { display: none; }
${R} [data-sidebar="sidebar"] [data-testid="app-sidebar-body"] > [data-testid="app-sidebar-top-reserve-row"] { position: sticky; top: 0; z-index: 3; }
${R} [data-sidebar="sidebar"] [data-testid="app-sidebar-body"] > [data-sidebar="content"] { flex: 0 0 auto; min-height: auto; overflow: visible; }
${R} [data-sidebar="sidebar"] [data-testid="app-sidebar-body"] > [data-sidebar="footer"] { position: sticky; bottom: 0; z-index: 3; margin-top: auto; }
${R} [data-sidebar="sidebar"] [data-sidebar-sticky-tier] { position: relative !important; top: auto !important; }
${edgeFadeCSS({
  name: "sidebar",
  scroller: `${R} [data-sidebar="sidebar"] [data-testid="app-sidebar-body"]`,
  rows: `[data-cf-nav] > button, [data-sidebar="group-label"], .group\\/thread-row, [data-sidebar="content"] [data-sidebar="menu-button"]`,
  top: "var(--bb-app-chrome-row-height, 3.25rem)",
  bottom: "var(--cf-sb-footer-h, 3.75rem)",
  mid: "1.5rem", // half a 48pt row
})}

/* The new-chat page on phones: bb lets its "Recent" list scroll under the composer band, which bb paints solid;
   ours is glass, so rows showed through it. Now rows fade as they pass under it (the sidebar's edge fade; bb
   already leaves room to scroll the last row clear of it), and the "Recent" label isn't sticky (it
   overlapped rows). */
@media (max-width: 767px) {
  ${R} [data-root-compose-mobile-recents] > .sticky { position: relative !important; }
}
${edgeFadeCSS({
  name: "recents",
  scroller: `${R} [data-testid="root-compose-compact-scroll-viewport"]`,
  rows: `[data-root-compose-mobile-recents] li, [data-root-compose-mobile-recents] h2`,
  bottom: "var(--cf-compose-band, 12rem)", // bb's composer band (~190pt on phones)
  mid: "1.875rem", // half a 60pt row
})}

/* Closed sheets are hidden once bb's slide-out ends. bb parks a closed sheet one sheet-height below its open
   place; our inset sheets float above the screen's bottom edge, so the inset (~8pt) stayed in view as a
   strip at the bottom (kayg: "wallpaper leaks from the bottom"). The delay lets the slide play first. */
@keyframes cf-sheet-gone { to { visibility: hidden; } }
${R} [data-persistent-drawer-content][data-state="closed"] { animation: cf-sheet-gone 0s linear 450ms forwards; }

/* Selection: on the root only. Chrome (131+) inherits ::selection from the root; a universal
   \`html ::selection\` made it compute a selection style for EVERY element, doubling each whole-page
   restyle bb does (sidebar toggle, menus, tooltips: ~2,100 -> ~1,100 elements, desktop trace
   2026-11-15). WebKit doesn't inherit it but computes it lazily, so Safari keeps the universal
   rule (the Apple Pay property is a WebKit-only feature test). */
${R}.dark { --cf-glass: blur(16px) saturate(180%) brightness(0.72); }
/* bb's toasts (Sonner): the one glass too. */
${R} [data-sonner-toast] {
  --normal-bg: var(--cf-glass-fill);
  background: var(--cf-glass-fill) !important;
  -webkit-backdrop-filter: var(--cf-glass);
  backdrop-filter: var(--cf-glass);
}
${R}::selection { background-color: color-mix(in oklab, var(--cf-accent) 38%, transparent); }
@supports (-apple-pay-button-style: inherit) {
  ${R} ::selection { background-color: color-mix(in oklab, var(--cf-accent) 38%, transparent); }
}
${R} .ProseMirror-hideselection ::selection { background-color: transparent; }

/* Composer attachments: one horizontally scrolling row, never a second row (kayg). bb's grid (a flex-wrap of
   tiles, stamped by marks.ts) stops wrapping and scrolls. It reaches out into the composer's 12px side padding
   and fades only there, so at rest no tile is faded; tiles fade as they scroll past an edge. */
${R} [data-cf-attach-strip] {
  flex-wrap: nowrap !important;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  scroll-padding-inline: 0.75rem;
  scrollbar-width: none;
  margin-inline: -0.75rem;
  padding-inline: 0.75rem;
  -webkit-mask-image: linear-gradient(to right, transparent, #000 0.75rem, #000 calc(100% - 0.75rem), transparent);
  mask-image: linear-gradient(to right, transparent, #000 0.75rem, #000 calc(100% - 0.75rem), transparent);
}
${R} [data-cf-attach-strip]::-webkit-scrollbar { display: none; }
${R} [data-cf-attach-strip] > * { flex: none; scroll-snap-align: start; }
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
  /* Offsets count from inside the bubble's 1px (transparent) border: subtract it, or the
     tail overlaps the bubble by 1px and the two translucent fills show a lighter seam. */
  right: calc(-0.5rem - 1px);     /* 8 units stick out to the right */
  bottom: calc(-0.125rem - 1px);  /* the point hangs 2 units below */
  width: 0.875rem;
  height: 1.25rem;
  background: var(--surface-recessed);
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 20'%3E%3Cpath d='M6 0C6.2 8 8.4 14 12.2 17.6C13.3 18.3 13.5 19 12.6 19.4C10 20.1 7.5 19.9 5 19C3.4 18.5 1.8 18 0 18L6 18Z'/%3E%3C/svg%3E") center / 100% 100% no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 14 20'%3E%3Cpath d='M6 0C6.2 8 8.4 14 12.2 17.6C13.3 18.3 13.5 19 12.6 19.4C10 20.1 7.5 19.9 5 19C3.4 18.5 1.8 18 0 18L6 18Z'/%3E%3C/svg%3E") center / 100% 100% no-repeat;
  pointer-events: none;
}

/* Wide chat (Settings → Chat layout, default): bb's 760px column becomes the whole card.
   Your bubbles reach its right end, the agent writes from its left end across the full
   width (a 48rem cap read as "back to narrow" in older messages), and the composer spans
   the same width. The selector must not rely on data-scroll-attached alone. The left gutter is room
   for the table-of-contents rail, which moves there. */
${R}[data-cf-wide] main [data-page-scroll-viewport] .max-w-\\[760px\\].mx-auto,
${R}[data-cf-wide] main div.max-w-\\[760px\\]:has(> [data-app-composer]) {
  max-width: none;
}
/* The left gutter is room for the table-of-contents rail: desktop only (phones have no rail,
   and the gutter cost the phone composer ~50px). */
@media (min-width: 768px) {
  ${R}[data-cf-wide] main [data-page-scroll-viewport] .max-w-\\[760px\\].mx-auto,
  ${R}[data-cf-wide] main div.max-w-\\[760px\\]:has(> [data-app-composer]) {
    padding-left: 3.25rem;
    padding-right: 1.5rem;
  }
}

/* bb's thread table of contents (the tick rail): on the left, out of the way, shown only
   while hovered, focused or open. */
${R} main div:has(> div > [data-thread-toc]) { align-items: flex-start !important; }
${R} [data-thread-toc] { opacity: 0; transition: opacity 160ms ease; }
${R} [data-thread-toc]:is(:hover, :focus-within, :has([aria-expanded="true"])) { opacity: 1; }
/* Its panel opens beside the rail: on the left side that is to the right (bb anchors it to
   the rail's left, which now is off the card). */
${R} [data-thread-toc] [id^="thread-toc-panel"] { right: auto !important; left: 100% !important; padding-right: 0 !important; padding-left: 0.25rem !important; }

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

/* Quiet sidebar: "More" appears only while the pointer is near it (over the top navigation)
   and bb's footer "…" only while it is over the footer row, or focus is inside them; each
   fades and slides in and takes its space only then.
   Touch screens have no hover: they always show. The footer item keeps bb's 2rem when shown
   (bb measures footer items to decide what overflows). */
@media (hover: hover) {
  ${R} [data-cf-nav-more] {
    max-height: 0;
    opacity: 0;
    translate: 0 -0.25rem;
    overflow: hidden;
    transition: max-height 220ms var(--cf-ease-out), opacity 180ms ease, translate 220ms var(--cf-ease-out);
  }
  ${R} [data-cf-nav]:is(:hover, :focus-within) [data-cf-nav-more],
  ${R} [data-cf-nav-more][data-open] { max-height: 2.25rem; opacity: 1; translate: 0 0; }

  ${R} [data-sidebar="footer"] li li[data-sidebar="menu-item"]:not([data-footer-item]) {
    width: 0;
    min-width: 0 !important;
    margin-inline-start: -0.25rem; /* the row's gap, so the hidden item takes no space at all */
    opacity: 0;
    translate: -0.375rem 0;
    overflow: hidden;
    transition: width 220ms var(--cf-ease-out), margin 220ms var(--cf-ease-out), opacity 180ms ease, translate 220ms var(--cf-ease-out);
  }
  ${R} [data-sidebar="footer"]:is(:hover, :focus-within) li li[data-sidebar="menu-item"]:not([data-footer-item]),
  ${R} [data-sidebar="footer"] li li[data-sidebar="menu-item"]:not([data-footer-item]):has([data-state="open"]) {
    width: 2rem;
    margin-inline-start: 0;
    opacity: 1;
    translate: 0 0;
  }
}
@media (hover: hover) and (prefers-reduced-motion: reduce) {
  ${R} :is([data-cf-nav-more], [data-sidebar="footer"] li li[data-sidebar="menu-item"]:not([data-footer-item])) { transition: opacity 120ms ease; translate: none !important; }
}

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
  top: var(--cf-foot-y); /* the model pill's centre line */
  translate: 0 -50%;
  height: var(--cf-tb-c);
  margin: 0 !important;
  /* A toolbar (pills.ts): bb pads this row 15px; here the capsule's padding and gaps are the
     shared toolbar tokens (desktop: none, its items are segments). Over the composer's glass
     it's a quiet tint. */
  padding: var(--cf-tb-pad) !important;
  border-radius: 999px;
  background: var(--cf-pill-quiet);
  min-height: 0 !important;
  max-height: none !important;
  width: auto !important;
  max-width: var(--cf-foot-w, none);
  overflow: hidden;
  z-index: 25;
  display: flex;
  align-items: center;
  gap: var(--cf-tb-gap);
}
${R} [data-app-composer][data-cf-merged] [data-follow-up-composer-footer] > div { display: contents; }
${R} [data-app-composer][data-cf-merged] [data-follow-up-composer-footer] :is([data-promptbox-hide-branch-compact], button[aria-label="New thread in this environment"]) { display: none !important; }
/* Order: context ring, permission, environment. */
${R} [data-app-composer][data-cf-merged] button[aria-label^="Context window"] { order: 1; }
${R} [data-app-composer][data-cf-merged] button[aria-label="Permission mode"] { order: 2; }
${R} [data-app-composer][data-cf-merged] :is([data-cf-env], button[aria-label^="Thread details"]) { order: 3; }
/* Phones show "Thread details: <branch>" instead of the environment: the branch icon only. */
${R} [data-app-composer][data-cf-merged] button[aria-label^="Thread details"] { width: var(--cf-seg-w); height: var(--cf-tbp-c); padding: 0 !important; justify-content: center; gap: 0 !important; color: var(--muted-foreground); }
${R} [data-app-composer][data-cf-merged] button[aria-label^="Thread details"] > span { display: none !important; }
/* Environment: the folder icon only; the name and branch live in its tooltip. */
${R} [data-app-composer][data-cf-merged] [data-cf-env] [data-option-display] { display: none !important; }
${R} [data-app-composer][data-cf-merged] [data-cf-env] { width: var(--cf-seg-w); height: var(--cf-tbp-c); padding: 0 !important; justify-content: center; color: var(--muted-foreground); }
${R} [data-app-composer][data-cf-merged] [data-cf-env] > * { justify-content: center; padding: 0 !important; margin: 0 !important; }
/* Permission: an icon per mode instead of the label and chevron; Full Access in amber. */
${R} [data-app-composer][data-cf-merged] button[aria-label="Permission mode"] { width: var(--cf-seg-w); height: var(--cf-tbp-c); padding: 0 !important; justify-content: center; gap: 0 !important; color: var(--muted-foreground); }
${R} [data-app-composer][data-cf-merged] button[aria-label="Permission mode"] > * { display: none !important; }
${R} [data-app-composer][data-cf-merged] button[aria-label="Permission mode"]::before {
  content: "";
  width: var(--cf-ci);
  height: var(--cf-ci);
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
${R} [data-app-composer][data-cf-merged] button[aria-label^="Context window"] { width: var(--cf-seg-w); height: var(--cf-tbp-c); margin: 0 !important; padding: 0 !important; justify-content: center; }
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
  width: var(--cf-cp);
  height: var(--cf-cp);
  border-radius: 999px;
  color: var(--muted-foreground);
  background: transparent;
  border: 0;
}
${R} [data-cf-model-chip] > * { width: var(--cf-ci); height: var(--cf-ci); }

/* Voice input (frame/voice.ts). While bb records, the merged icon row steps aside (it was
   drawn over the waveform), and the waveform becomes an accent-tinted pill that grows out
   of the mic's side, with an elapsed clock at its end. bb paints the bars in the canvas's
   CSS colour. */
${R} [data-app-composer][data-cf-voice] [data-follow-up-composer-footer] { display: none !important; }
${R} [data-cf-voice-pill] {
  height: var(--cf-cp);
  gap: 0.5rem;
  padding-inline: 0.875rem 0.75rem;
  border-radius: 999px;
  background: color-mix(in oklab, var(--cf-accent) 18%, transparent);
  color: color-mix(in oklab, var(--cf-accent) 55%, var(--foreground));
  animation: cf-voice-pill-in 200ms var(--cf-ease-out);
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
/* Grows out of the mic's side by revealing, never by squashing its contents (no tiny scale). */
@keyframes cf-voice-pill-in {
  from { clip-path: inset(0 0 0 85% round 999px); opacity: 0.4; }
  to { clip-path: inset(0 0 0 0 round 999px); opacity: 1; }
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
${R} [data-cf-keyboard] [data-cf-kb] { display: inline-flex; }

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
  /* The one glass (--cf-glass), as every floating surface. */
  background: var(--cf-glass-fill);
  -webkit-backdrop-filter: var(--cf-glass);
  backdrop-filter: var(--cf-glass);
  color: var(--cf-tip-ink);
  font: 500 0.75rem/1.3 var(--font-sans);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--foreground) 8%, transparent), 0 6px 18px -8px rgb(0 0 0 / 0.45);
  pointer-events: none;
  opacity: 0;
  /* No filter blur on the tooltip itself (it fought the backdrop blur): a small scale and a fade. */
  scale: 0.97;
  transform-origin: center bottom;
  transition: opacity 125ms cubic-bezier(0.23, 1, 0.32, 1), scale 125ms cubic-bezier(0.23, 1, 0.32, 1);
}
${R}.dark [data-cf-tip] { box-shadow: 0 0 0 1px rgb(255 255 255 / 0.06), 0 6px 18px -8px rgb(0 0 0 / 0.6); }
${R} [data-cf-tip][data-side="bottom"] { transform-origin: center top; }
${R} [data-cf-tip]:is([data-state="open"], [data-state="open-instant"]) { opacity: 1; scale: 1; }
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
/* No arrow: a second small glass square would overlap the first (and Apple's tooltips have none). */
${R} [data-cf-tip] i { display: none !important; }
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

/* Popovers grow from their trigger (origin-aware): Radix exposes the side it opened from. */
${R} [data-radix-popper-content-wrapper] > [data-state] { transform-origin: var(--radix-popper-transform-origin); }

/* Every floating menu (context menus, dropdowns, drop-ups, pickers) gets the same glass as the
   context menu; panels inside them go clear so it reads as one surface. */
${R} :is([role="menu"], [role="listbox"], [data-radix-popper-content-wrapper] > [data-state]) :is(.bg-popover, .bg-card, .bg-background, .bg-muted, .bg-surface-raised, .bg-surface-recessed, .bg-surface-raised-solid) {
  background-color: transparent !important;
}
/* bb's own panel inside a popup (the context hover card) also brings a border and shadow:
   a card inside the glass card. Only the outer glass keeps an edge. */
${R} [data-radix-popper-content-wrapper] > [data-state] > :is(.bg-popover, .bg-card) {
  border-color: transparent !important;
  box-shadow: none !important;
}
${R} :is([role="menu"], [role="listbox"], [data-radix-popper-content-wrapper] > [data-state]) {
  /* Concentric corners: outer radius = item radius + padding (14 = 8 + 6). */
  border-radius: var(--cf-radius) !important;
  padding: 6px !important;
  /* Hover and highlight inside menus read as the accent, not grey. */
  --state-hover: color-mix(in oklab, var(--cf-accent) 26%, transparent);
  --accent: color-mix(in oklab, var(--cf-accent) 26%, transparent);
  background-color: var(--cf-glass-fill) !important;
  -webkit-backdrop-filter: var(--cf-glass);
  backdrop-filter: var(--cf-glass);
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
  background-color: var(--cf-glass-fill) !important;
  -webkit-backdrop-filter: var(--cf-glass);
  backdrop-filter: var(--cf-glass);
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
  /* The sidebar's slide: bb's 200ms LINEAR curve felt mechanical ("laggy"). Emil Kowalski's strong ease-out
     instead: the motion starts at once and settles softly. Both moving parts take it, so the card's edge
     stays on the sidebar's: the fixed sidebar itself and the gap element that pushes the card.
     sidebar-top.ts copies this timing for the toggle. Keyboard toggles are instant (input-mode.ts). */
  ${R} [data-side][data-variant] > :is([data-sidebar="gap"], .fixed) {
    transition-duration: 220ms !important;
    transition-timing-function: var(--cf-ease-out) !important;
  }

  /* (The overlay's shift is sidebar-top.ts's --cf-toggle-dx, so it slides; it sets the attribute
     below, which replaces a root :has() that re-checked the whole document on every data-state change.) */
  ${R}[data-cf-sb-collapsed] [data-testid="app-desktop-sidebar-trigger"] {
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
    /* Transparent: kayg wants no painted edge (any tint showed as a white line when zoomed).
       The 1px width stays, so nothing that lines up with the card moves. */
    border: 1px solid transparent;
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
    background: var(--cf-wall-card, var(--cf-wall, none)) center / cover no-repeat fixed;
    filter: var(--cf-card-filter, var(--cf-card-blur));
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
  /* keyboard-follow.ts: while the composer rides up with the keyboard, the shell keeps its old size over bb's
     inline top/height and its bottom inset (the composer is translated; the real layout returns at the end). */
  ${R} [data-app-content-shell][data-cf-kb-hold] {
    top: var(--cf-kb-hold-top) !important;
    height: var(--cf-kb-hold-h) !important;
    --bb-content-bottom-inset: var(--cf-kb-hold-pb) !important;
  }
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
    /* bb slides this pane with a translate transition (its class): keep it. An earlier transition here for
       the corners and shadow replaced bb's, so the drawer and the right panel jumped instead of sliding.
       The corners and shadow switch at once (animating them repainted the full-screen pane every frame). */
    transition: translate 220ms cubic-bezier(0.32, 0.72, 0, 1);
  }
  /* At rest the pane is a full-screen sheet. When it slides aside for the drawer or the
     right panel, it becomes the floating card: rounded, with the card's edge and shadow. */
  /* A right-to-left drag reveals the right panel, never the left drawer that lies under the pane (touch.ts). */
  ${R}[data-cf-dragging-right] ${SIDEBAR} { visibility: hidden; }
  ${MAIN}:is([data-sidebar-shelf]:not([data-sidebar-shelf="closed"]), [data-panel-shelf]:not([data-panel-shelf="closed"]), [data-cf-dragging]) {
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
    background: var(--cf-side) var(--cf-wall-card, var(--cf-wall, none)) center / cover no-repeat;
    filter: var(--cf-card-filter, var(--cf-card-blur));
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
  ${R} [data-testid="app-layout-root"] [data-sidebar="sidebar"][data-cf-short] { overflow-y: auto; }
  ${R} [data-testid="app-layout-root"] [data-sidebar="sidebar"][data-cf-short] [data-sidebar="content"] { flex: 0 0 auto; min-height: auto; overflow: visible; }
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
     attachments are one scrolling row (below), and the text area is capped to a share of the visible height
     (--cf-vvh is the visual viewport height, set by frame/touch.ts). */
  ${R} [data-cf-keyboard] [data-promptbox-editor-scroll] { max-height: calc(var(--cf-vvh, 100dvh) * 0.28) !important; }
  /* ── Native reading (phones), measured from Claude's and ChatGPT's iOS apps (2026-11-15): body 17pt with a
     ~1.55 line height, ~0.85em between paragraphs, text 16pt from the screen edges (bb: 15px, 24pt), headings
     a step larger than the body (bb's h3 was body-sized), and near-white text in dark (bb's measured 0.81). */
  ${MAIN} [data-page-scroll-viewport] .max-w-\\[760px\\].mx-auto { padding-inline: calc(0.5rem * var(--cf-ui-scale, 1)) !important; }
  ${MAIN} [data-timeline-row-id] .max-w-none {
    font-size: calc(17px * var(--cf-ui-scale, 1));
    line-height: 1.55;
  }
  ${MAIN} [data-timeline-row-id] .max-w-none > :is(p, ul, ol, blockquote) { margin-top: 0; margin-bottom: 0.85em; }
  ${MAIN} [data-timeline-row-id] .max-w-none li + li { margin-top: 0.3em; }
  ${MAIN} [data-timeline-row-id] .max-w-none :is(h1, h2, h3, h4) { font-weight: 650; line-height: 1.3; margin: 1.15em 0 0.45em; letter-spacing: -0.01em; }
  ${MAIN} [data-timeline-row-id] .max-w-none h1 { font-size: 1.4em; }
  ${MAIN} [data-timeline-row-id] .max-w-none h2 { font-size: 1.25em; }
  ${MAIN} [data-timeline-row-id] .max-w-none h3 { font-size: 1.1em; }
  ${MAIN} [data-timeline-row-id] .max-w-none h4 { font-size: 1em; }
  ${MAIN} [data-timeline-row-id] .max-w-none > :is(h1, h2, h3, h4):first-child { margin-top: 0; }
  ${MAIN} [data-timeline-row-id] .max-w-none :not(pre) > code { font-size: 0.88em; }
  /* Your bubbles read at the same size, their edge on the same 16pt line as the text (the tail hangs into the margin). */
  ${MAIN} [data-timeline-row-id*=":user-"] .rounded-xl.bg-surface-recessed { font-size: calc(17px * var(--cf-ui-scale, 1)); line-height: 1.45; margin-right: calc(0.5rem * var(--cf-ui-scale, 1)); }
  ${R}.dark ${MAIN.slice(R.length + 1)} { --foreground: oklch(0.95 0 0); }
  /* Code blocks like Claude's: 20pt corners, a 44pt header with the language in the text font (bb: tiny
     uppercase mono), a hairline under it, 16pt padding, 14.5pt code. bb's block: wrapper
     .overflow-hidden.rounded-md.border.bg-surface-recessed > header .justify-between + pre.bb-code-highlight. */
  ${MAIN} [data-timeline-row-id] .max-w-none div.overflow-hidden.rounded-md.border.bg-surface-recessed { border-radius: calc(20px * var(--cf-ui-scale, 1)) !important; }
  ${MAIN} [data-timeline-row-id] .max-w-none div.overflow-hidden.rounded-md.border.bg-surface-recessed > div.justify-between:first-child {
    min-height: calc(44px * var(--cf-ui-scale, 1));
    padding: 0 calc(6px * var(--cf-ui-scale, 1)) 0 calc(16px * var(--cf-ui-scale, 1)) !important;
    border-bottom: 1px solid var(--cf-edge);
  }
  ${MAIN} [data-timeline-row-id] .max-w-none div.overflow-hidden.rounded-md.border.bg-surface-recessed > div.justify-between:first-child .font-mono {
    font-family: inherit !important;
    font-size: calc(15px * var(--cf-ui-scale, 1)) !important;
    text-transform: none !important;
    letter-spacing: 0 !important;
    color: var(--muted-foreground);
  }
  ${MAIN} [data-timeline-row-id] .max-w-none div.overflow-hidden.rounded-md.border.bg-surface-recessed > div.justify-between:first-child button { width: calc(36px * var(--cf-ui-scale, 1)) !important; height: calc(36px * var(--cf-ui-scale, 1)) !important; }
  ${MAIN} [data-timeline-row-id] .max-w-none div.overflow-hidden.rounded-md.border.bg-surface-recessed > div.justify-between:first-child button svg { width: calc(18px * var(--cf-ui-scale, 1)) !important; height: calc(18px * var(--cf-ui-scale, 1)) !important; }
  ${MAIN} [data-timeline-row-id] .max-w-none div.overflow-hidden.rounded-md.border.bg-surface-recessed pre {
    padding: calc(12px * var(--cf-ui-scale, 1)) calc(16px * var(--cf-ui-scale, 1)) calc(16px * var(--cf-ui-scale, 1)) !important;
    font-size: calc(14.5px * var(--cf-ui-scale, 1)) !important;
    line-height: 1.35 !important;
  }
  /* Message actions like Claude's: 18pt icons in 32pt buttons (bb: 12pt icons in 20pt buttons), 32pt apart,
     the first icon on the text's edge. */
  ${MAIN} [data-timeline-row-id] [data-message-column] > .relative.w-full { height: calc(32px * var(--cf-ui-scale, 1)) !important; margin-top: calc(4px * var(--cf-ui-scale, 1)); }
  ${MAIN} [data-timeline-row-id] [data-message-column] > .relative.w-full > div > div:first-child { gap: 0 !important; margin-left: calc(-1px * var(--cf-ui-scale, 1)); }
  ${MAIN} [data-timeline-row-id] [data-message-column] > .relative.w-full > div > div:first-child :is(span, div) { gap: 0 !important; }
  ${MAIN} [data-timeline-row-id] [data-message-column] > .relative.w-full > div > div:first-child button { width: calc(32px * var(--cf-ui-scale, 1)) !important; height: calc(32px * var(--cf-ui-scale, 1)) !important; margin: 0 !important; }
  ${MAIN} [data-timeline-row-id] [data-message-column] > .relative.w-full > div > div:first-child button svg { width: calc(18px * var(--cf-ui-scale, 1)) !important; height: calc(18px * var(--cf-ui-scale, 1)) !important; }
  ${MAIN} [data-timeline-row-id] [data-message-action-metadata] { font-size: calc(13px * var(--cf-ui-scale, 1)) !important; }
  /* ── The drawer like Claude's and ChatGPT's (measured, 2026-11-15): about 75% of the screen wide (bb: 86%,
     max 360), rows 48pt with 17pt labels and 20pt icons (bb: 36–40, 15px, 14px icons), quiet 15pt section
     headers, and a neutral grey for the selected and pressed rows instead of the accent tint. bb sets its
     drawer width inline; a custom property with !important wins over an inline one. */
  ${R} [style*="--sidebar-width-mobile"] { --sidebar-width-mobile: min(75vw, 330px) !important; }
  ${SIDEBAR} {
    --sidebar-accent: color-mix(in oklab, var(--foreground) 10%, transparent);
    --accent: color-mix(in oklab, var(--foreground) 10%, transparent); /* the plugin nav's selected row (ui/nav.tsx bg-accent) */
    --accent-foreground: var(--foreground);
    --state-hover: color-mix(in oklab, var(--foreground) 8%, transparent);
    --state-active: color-mix(in oklab, var(--foreground) 12%, transparent);
  }
  ${SIDEBAR} :is([data-cf-nav] > button, .group\\/thread-row) {
    height: calc(48px * var(--cf-ui-scale, 1)) !important;
    border-radius: calc(12px * var(--cf-ui-scale, 1)) !important;
  }
  ${SIDEBAR} :is([data-cf-nav] > button, .group\\/thread-row, .group\\/thread-row .text-sm) { font-size: calc(17px * var(--cf-ui-scale, 1)) !important; }
  ${SIDEBAR} [data-cf-nav] > button svg { width: calc(20px * var(--cf-ui-scale, 1)) !important; height: calc(20px * var(--cf-ui-scale, 1)) !important; }
  ${SIDEBAR} [data-sidebar="group-label"] {
    font-size: calc(15px * var(--cf-ui-scale, 1)) !important;
    font-weight: 400 !important;
    color: var(--muted-foreground) !important;
    margin-top: calc(8px * var(--cf-ui-scale, 1));
  }
${cardInterior(MAIN)}}
${PILL_CSS}
${PILL_SIDEBAR_CSS}
${PILL_COMPOSER_CSS}
${PILL_PHONE_CSS}
${TITLE_PILL_CSS}
${PILL_SETTINGS_CSS}
${PHONE_MENU_CSS}
`;

/**
 * Everything inside the chat pane: floating header with its frost, the composer's frosted
 * band and pane, glass panels. Shared by the desktop card and the full-screen mobile pane.
 */
function cardInterior(scope: string): string {
  return `
  /* Message actions (copy, reply, time): bb puts them straight after the message, so the gap
     was whatever the last block's margin was (3px after a paragraph, 12px after a list). The
     trailing margins go and the row gets its own 0.5rem: 12px every time, like your bubbles. */
  ${scope} [data-timeline-row-id] .max-w-none > :last-child,
  ${scope} [data-timeline-row-id] .max-w-none > :last-child > li:last-child { margin-bottom: 0; }
  /* Subject form (the content div itself, when the actions row follows it): a sibling-combinator :has() before
     the styled element would be non-subject (see marks.ts). */
  ${scope} [data-timeline-row-id] div:has(> .max-w-none):has(+ .relative.w-full) { margin-bottom: 0.5rem; }
  /* Light mode: the header's icon buttons are bb's grey at 75%, too faint on the light card. */
  ${scope}:where(html:not(.dark) *) header button { color: color-mix(in oklab, var(--foreground) 82%, transparent); }
  /* Finished tool rows ("Ran 3 commands"): bb shows them in its subtle colour at 40% opacity,
     which measured ~2:1. Any fade below ~85% fails on light glass, so they stay quieter by
     colour alone: the subtle grey, inked so it measures >= 4.5:1 in both themes, no fade. */
  ${scope} [data-timeline-row-id] .opacity-40 { opacity: 1; }
  ${scope}:where(.dark *) { --subtle-foreground: oklch(0.73 0 0); }
  ${scope}:where(html:not(.dark) *) { --subtle-foreground: oklch(0.46 0 0); }
  /* Dark mode: bb's muted text measured 4.4:1 on the card; lifted to ~5:1. */
  ${scope}:where(.dark *) { --muted-foreground: var(--cf-card-muted); }
  /* bb's own panels inside the card (settings groups, skill tiles) become faint glass. */
  ${scope} { --card: color-mix(in oklab, var(--foreground) 4.5%, transparent); --surface-scrim: transparent; }
  ${scope} header { border-bottom-color: transparent !important; }

  /* Chat scroll edges: text fades out under the header and frosts away behind the composer,
     instead of stopping at a hard line or showing through the clear composer footer. */
  /* The page header floats over its scroll area instead of sitting in a band above it:
     content scrolls up under the title and fades out gradually across the header's
     whole height. bb's own header row height drives the padding and the fade. */
  ${scope} :has(> header + * [data-page-scroll-viewport]) { position: relative; }
  ${scope} header[data-cf-scroll-header] {
    position: absolute !important;
    inset: 0 0 auto 0;
    z-index: 15;
    pointer-events: none;
  }
  ${scope} header[data-cf-scroll-header] > * { pointer-events: auto; }
  /* Text sliding under the title fades out behind a short plain colour gradient, only as
     tall as the title row. No blur: a masked backdrop blur rendered as a frosted block with a
     hard edge in some Chromium builds. */
  ${scope} header[data-cf-scroll-header]::before {
    content: "";
    position: absolute;
    inset: 0 0 -0.75rem 0;
    z-index: -1;
    pointer-events: none;
    background: linear-gradient(to bottom, color-mix(in oklab, var(--cf-bg) 80%, transparent) 0%, color-mix(in oklab, var(--cf-bg) 55%, transparent) 55%, transparent 100%);
  }
  /* The same fade at the bottom edge (kayg, 2026-11-15): text sliding toward the card's
     bottom fades out over the same height and gradient as under the title, mirrored. It lives
     in the sticky composer area (a stacking context), beneath the composer, so the composer's
     glass sits over it; a plain colour gradient, never a masked blur (see the title fade). */
  ${scope} [data-page-scroll-viewport] .sticky.bottom-0:has([data-app-composer])::before {
    content: "";
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: calc(var(--bb-app-chrome-row-height, 3rem) + 0.75rem);
    z-index: -1;
    pointer-events: none;
    background: linear-gradient(to top, color-mix(in oklab, var(--cf-bg) 80%, transparent) 0%, color-mix(in oklab, var(--cf-bg) 55%, transparent) 55%, transparent 100%);
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

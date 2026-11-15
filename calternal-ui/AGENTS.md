# calternal-ui: notes for agents

Formerly `calternal-frame` (renamed 2026-11-15; the `cf` prefix on attributes and CSS variables is from that name). Read this before changing anything. Keep it short; update it in the same commit as the code.

## What it is

A bb plugin that restyles bb's own shell, after Craft's window:

- **Window backdrop:** the wallpaper, blurred and tinted. One seamless surface.
- **Sidebars:** the left one and the right panel have no surface of their own. They sit flat on the backdrop: no fill, edges or seams.
- **Chat card:** touches the window's top and bottom, with a 12px gap to the sidebars at the sides (kayg's choice over Craft's gap on all sides; 12px since 2026-11-15, to give the shadow room). It has no top/bottom border (a translucent border at the window edge showed a strip of wallpaper) and the same corner as the phone pane (`--cf-device-radius`, squircle). It's heavy glass (blur, tint and dim).
- **Composer:** its own frosted pane inside the card.
- **Accent:** one colour (from the wallpaper or custom) drives bb's grey palette: primary, hover, selection, menus, switches.
- **Extras:** Google Fonts stored locally, a wallpaper library with Unsplash, a denser composer, and compact navigation. (Usage in the sidebar footer belongs to the sibling `cliproxy-usage` plugin.)

## Map

| Path | What |
|---|---|
| `app.tsx` / `server.ts` | Entry points; registration and wiring only |
| `shared/contract.ts` | All data shapes and the RPC contract (zod). The app imports types only |
| `shared/defaults.ts` | Opinionated defaults (no zod, so the UI can import them) |
| `server/` | `store` (SQLite kv + prefs), `wallpapers` (library), `unsplash`, `fonts`, `assets` (storage list and removal) |
| `frame/` | Styling bb's DOM: `selectors`, `css`, `mount` (content script), `wallpaper`, `prefs`, `accent`, `color`; behaviour: `composer`, `tooltip`, `touch`, `swipe`, `times`, `attachments` |
| `ui/` | React: `overlay` (sync), `nav` + `nav-actions` (footer + and search), `settings/` |

## Rules learned the hard way

- **Never put `mask`, `filter`, `backdrop-filter`, `opacity < 1` or `clip-path` on an ancestor of the composer.** Chromium treats such an ancestor as a *backdrop root*, and the composer stops blurring. That's why the card's glass lives in `::before`/`::after` layers. Never put a mask on a backdrop-filter either: Aside's Chromium draws it as a block with a hard edge. The title fade is a plain colour gradient on `header::before`.
- **Shadows must fit inside `--cf-gap`.** bb clips the centre region, so a wider shadow gets cut off in a straight line. The card's float comes from a two-layer shadow (contact + soft, blur minus spread = the gap) and from contrast: bright sidebars (35% tint), deep card (85% tint, 30% dim). kayg declined a lit border.
- **Test light mode on every change.** "Dim" deepens toward the theme (`--cf-dim-rgb`: black in dark, white in light; prefs set only the strength `--cf-*-dim-a`). A black wash made the light card muddy grey. In light mode, sidebar text is inked darker (the wallpaper there is bright). bb's Tailwind colours resolve variables at the root, so check computed colours, not just the variable.
- **The card has no painted edge** (transparent 1px border, kept for layout): kayg saw any tint as a white line.
- **Inside the card, `--background` is transparent.** Anything floating must use `bg-popover`. bb's inverse controls (`bg-foreground` + `text-background`) and switches are re-styled in `css.ts`.
- **Selectors target bb 0.49.** When bb changes its DOM, fix `frame/selectors.ts` first. Desktop "framed" mode is `[data-framed]`.
- **The collapsed-sidebar toggle shifts only while collapsed.** Expanded, it lines up with the sidebar row.
- **100% interface size is 17.6px root on desktop** (bb's 110%) **and 16px on phones**, where bb already enlarges touch targets. bb is rem-based, so this scales text and controls together. On touch, the compact nav rows match bb's own row height.
- **Pages without a panel group** (Settings, Skills) use their content shell as the card.
- **Phones (<768px) have a different shell.** `main` is a full-screen pane that slides aside to reveal the sidebar drawer *beneath* it. On phones it's the glass pane: full-bleed at rest, and rounded (28px, with the card's edge and shadow) whenever it slides aside for the drawer or the right panel, with a solid base so the drawer never shows through. The right panel is a portaled shelf with heavy frost. The card interior rules (`cardInterior()` in `css.ts`) are shared, so add new interior styling there, not only in the desktop block.
- **Touch behaviour lives in `frame/touch.ts`** and installs on any touch device (`maxTouchPoints > 0`):
  - Opening the drawer dismisses the keyboard.
  - `html[data-cf-short]` (visible area under 560px) makes the sidebar scroll as one column.
  - Pulling down at the top of the sidebar opens search. It's vertical only, so bb's sideways edge swipes stay bb's.
  - To test headless, enable CDP `Emulation.setTouchEmulationEnabled`, then use `p.touchscreen`.
- **Your messages have iMessage tails:** an SVG-masked `::after` (14×20 viewBox) right of and below the bubble, never over it, so translucent fills don't double. The bubble's bottom-right corner is square and its border removed; the tail flares from that straight edge into a point just below the bubble, and its lower edge sweeps back under it, like iMessage. Check shapes on a blank page with the plugin's stylesheet and a solid fill: the live thread scrolls and the real fill is too faint to judge.
- **bb's thread context strip above the composer is hidden** (`section[aria-label="Thread context before sending"]`: git changed files, pull request). The right sidebar's info tab shows the same, and kayg wants status info there, not in the chat.
- **Nothing is drawn behind the composer.** Both a masked blur band and a colour fade there read as a block; kayg wants neither.
- **The composer's glass is a `form::before` layer, not a backdrop-filter on the form.** With the filter on the form, Chromium re-composited its content on every keystroke and attachment thumbnails flickered. Apply the same rule to any glass that holds images or text being edited.
- **Warm tooltips (`frame/tooltip.ts`)** are our own implementation of the warm-tooltip idea (sveltebits is a visual reference only; never copy its code):
  - One shared delay (450ms cold). After a close, the next tooltip opens instantly for 700ms, and an open one glides to the next trigger, with 80ms of grace across gaps.
  - Labels come from `aria-label`/`title`, with `aria-keyshortcuts` as a shortcut chip. Only controls whose *rendered* text doesn't already say it get one: bb's icon buttons carry 1px screen-reader labels, which don't count.
  - bb's own tooltips are hidden, and native `title`s are moved to `data-cf-title`.
  - It points at the nearest element with a box: bb sometimes puts a `title` on a `display: contents` span (the model pill), whose rect is 0,0.
  - Only the trigger's own blur or scroll closes it: bb shifts focus and a live thread scrolls constantly. Mouse and keyboard only; touch never shows them.
- **Composer (`frame/composer.ts`):** one bottom row, `[+] [model] [context ring] [permission] [environment] ··· [mic] [send]`.
  - bb's row under the composer is *positioned* into the free space after the model button (`--cf-foot-x/y/h/w`, one `ResizeObserver`), never moved. It shares the model button's box (not the row's), has no padding or gap, and every icon is a 2rem box, so all glyph gaps are 1rem like + → model. Its wrappers are `display: contents`, so `order` applies to their children.
  - Labels become icons with tooltips (`data-cf-title`): a folder for the environment ("Personal workspace · main"; phones show "Thread details: <branch>" instead, as a branch icon), one icon per permission mode (Full Access in amber), and the context % only from 80%.
  - "New thread here" is appended to the + menu when it opens; bb's own button stays the action.
  - "Collapsed" means bb's attribute *and* no visible model button: desktop composers get `data-promptbox-collapsed` after Escape while showing everything.
  - The one-line chip must never match bb's model-button selector (`:not([data-cf-model-chip])`): when it did, collapsed/expanded flipped every frame and the chip flickered.
  - Phones, collapsed: bb renders neither the footer nor the model button. The model icon (bb's `[data-provider-logo]` span, not an svg) is cached in localStorage and shown before the mic; tapping it expands the composer, then opens the picker.
- **No tooltip while bb's own floating content is open** (`[data-radix-popper-content-wrapper]`): the context ring's hover card already explains it. An open tooltip steps aside when one appears.
- **Voice input (`frame/voice.ts`, driven by the composer pass):** while bb records, the composer gets `data-cf-voice` and the merged icon row hides (it used to cover the waveform). The waveform's box is an accent pill with an elapsed clock; bb paints the bars in the canvas's CSS colour. The failed-recording card is a faint tint, not bb's grey slab. To test headless, replace `navigator.mediaDevices.getUserMedia` with an oscillator stream (`evaluateOnNewDocument`).
- **Tooltips skip triggers whose menu is open** (`aria-expanded="true"` or `data-state="open"`). A warm tooltip opens on the next frame; a press in that frame cancels it, or it pops up over the menu the press opened.
- **Spacing is optical, not box-based.** In compact `gap-1` buttons a leading icon gets +2px and a trailing chevron −2px, so icon → text, text → text and text → chevron all read about 6px.
- **The nav lines up with bb's thread rows:** the same `text-sm`, a 14px icon centred in a 16px slot, a fixed 8px left inset (bb's is px, not the scaled spacing unit), and the same gap. Rows are only shorter, for density. Never give the nav its own font size.
- **Sidebar defaults:** New thread and Search threads are not in the nav (`ui/nav.tsx` filters bb's ids `__bb__/new-thread`, `__bb__/search-threads`). They are footer actions instead (`app.tsx`), running the same nav actions through `ui/nav-actions.ts`. The footer row reads `usage ···· + search settings …`. `css.ts` only sets `order` on bb's `li[data-footer-item]`, so bb's overflow menu keeps working.
- **Every floating menu uses the context-menu glass**, and panels inside popovers (`bg-popover`, `bg-card`, …) go clear. So do lists nested in a menu, picker or dialog (no second glass layer). Modal dialogs (the desktop search palette) get the same glass; phone sheets keep theirs.
- **Outside the card, bb's light surfaces are opaque white.** Audit light mode separately: the strip above the composer (`section.bg-surface-raised-solid`) uses the composer glass, mention pills get a faint tint (bb also paints them with a gradient), and amber text uses `--cf-warn-ink`, darker in light mode.
- **Shared glass tokens:** `--cf-glass-fill`, `-blur`, `-highlight` and `-shadow` (in `css.ts`) are the one look for floating panes: the composer and inset sheets. Reuse them; don't invent new values.
- **Swipe actions (`frame/swipe.ts`)** run bb's own actions:
  - Thread row: left archives (the row's own Archive button), right toggles pin (the context menu, opened silently; on touch it's an action sheet).
  - Message: left copies (its Copy button), right quotes into the composer as a synthetic paste. Never simulate Enter, which sends.
  - A thread row is `[data-sidebar-rename-row][role="button"]`; the section wrapper reuses the attribute without the role.
  - Rows are marked `data-no-sidebar-swipe` on `pointerdown` in the capture phase. bb decides its drawer swipe there, before `touchstart`.
  - Never dispatch Escape: it closes bb's drawer.
- **Keyboard-down button:** shown while the composer's editor has focus on a touch device (`html[data-cf-keyboard]`). It sits right after bb's mic ("Start voice input") and copies its classes. bb refocuses the editor on any press inside the composer, so the button swallows every event of the press and then blurs. While typing, attachment thumbnails shrink and the editor is capped at 28% of `--cf-vvh` (the visual viewport height).
- **Message swipes are iMessage-like:**
  - Left to right replies (1:1 to the threshold, then resistance, with a growing reply arrow).
  - Right to left reveals times: the whole `[data-timeline-row-list]` slides left, and times appear at the chat's right edge. Nothing runs on release.
  - bb renders no times on phones, so they come from the `message_times` RPC (`bb.sdk.threads.timeline`; its row ids match `[data-timeline-row-id]`). They reach the content script through `frame/times.ts`, a loader the overlay registers.
  - Rows use `content-visibility`, which clips overflow. That's why the times sit on one fixed layer, not inside the rows.
- **Phone composer attachments (`frame/attachments.ts`):** bb's attachment grid is hidden (`[data-cf-attach="collapsed"]`). A chip (count + up to three mini thumbnails) sits last in the left button group, and its auto margin centres it in the gap. Tapping it opens bb's own grid as a horizontal, snapping strip. bb's DOM is only marked, never moved. A `MutationObserver` on the composer ignores edits inside the editor.
- **Pull to search** starts from the top of the sidebar, from the chat's title bar (any scroll position), or in a chat scrolled to the very top. bb anchors long threads and loads older messages, so "the top" is rare there.
- **The sliding phone pane uses `--cf-device-radius`** (the screen's corner), like Claude's iOS app, plus `corner-shape: squircle` where supported.
- **The search palette is bb's `[data-persistent-drawer-content]`.** On phones it's an inset sheet whose radius is concentric with the screen corners: `--cf-device-radius` (the 16 Pro Max's ~62pt) minus `--cf-sheet-inset`.
- **A blur fades its own edges to transparent.** Blurred layers overhang by 160px (more than 2× the largest blur).
- **Everything downloaded is listed in Settings → Storage** (`server/assets.ts`): wallpapers (the library table) and installed fonts (`font:<family>` keys). Removing really frees the space: `VACUUM`, then `wal_checkpoint(TRUNCATE)`, since bb's databases use WAL and the file only shrinks at a checkpoint. Removing a font in use switches its override off. Any new kind of download must show up there too.
- **Every library change must bump `updatedAt`** (`store.touch()`): the app re-reads lists when it moves. Deleting a wallpaper that wasn't active once left the tile on screen.
- **The active wallpaper is stored once,** in the library table; `wallpaperActive` names it. Older versions also copied it under `wallpaper`; `migrateLegacy()` drops that copy.
- **Browsers expose no desktop-wallpaper API.** Users upload, paste a URL, or pick from Unsplash.
- **Unsplash terms:** call `download_location` on every new use, add UTM parameters to links, and show the credit.
- **Fonts are installed on the server** (woff2, Latin and Latin Extended, inlined into CSS). Pages make no Google requests; only the picker's previews load from Google.

## Performance

- The backdrop and card blurs paint static images. Never animate anything behind glass.
- The wallpaper is decoded once (`frame/color.ts`, memoised) for both the sidebar tone and the accent.
- The always-on sync uses `frame_light`, a few KB. It fetches the wallpaper (~1 MB) only when `wallpaperId` changes, and fonts only when the set of enabled families changes. That matters when bb is used remotely.
- Style text is only rewritten when it changes, and the last look is cached in localStorage so a reload paints immediately.

## Work loop

```sh
npx tsc --noEmit -p . && bb plugin build && bb plugin reload calternal-ui
```

Verify visually: `bb browser-automation open --backend local --headless` opens `http://127.0.0.1:38886`. On hd01, Chrome runs from `~/.local/share/bb-chrome` and needs no root. Use `p.shot()`; puppeteer `clip` screenshots re-lay out the page and lie. Test blur with sharp text behind the element.

## kayg's preferences

- Opinionated defaults, with configuration kept in the plugin's settings.
- Details matter: alignment, concentric radii, no stray bands or seams. Check every route with screenshots.
- Atomic commits, pushed to both `origin` (Forgejo) and `github`.

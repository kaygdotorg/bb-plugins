# calternal-frame: notes for agents

Read this before changing anything. Keep it short; update it in the same commit as the code.

## What it is

A bb plugin that restyles bb's own shell, after Craft's window:

- **Window backdrop:** the wallpaper, blurred and tinted. One seamless surface.
- **Sidebars:** the left one and the right panel have no surface of their own. They sit flat on the backdrop: no fill, edges or seams.
- **Chat card:** floats on the backdrop with an 8px gap. It's heavy glass (blur, tint and dim).
- **Composer:** its own frosted pane inside the card.
- **Accent:** one colour (from the wallpaper or custom) drives bb's grey palette: primary, hover, selection, menus, switches.
- **Extras:** Google Fonts stored locally, a wallpaper library with Unsplash, pooled Claude/Codex usage bars, and compact navigation.

## Map

| Path | What |
|---|---|
| `app.tsx` / `server.ts` | Entry points; registration and wiring only |
| `shared/contract.ts` | All data shapes and the RPC contract (zod). The app imports types only |
| `shared/defaults.ts` | Opinionated defaults (no zod, so the UI can import them) |
| `server/` | `store` (SQLite kv + prefs), `wallpapers` (library), `unsplash`, `fonts`, `usage` |
| `frame/` | Styling bb's DOM: `selectors`, `css`, `mount` (content script), `wallpaper`, `prefs`, `accent`, `color` |
| `ui/` | React: `overlay` (sync + footer portal), `usage-bars`, `nav`, `settings/` |

## Rules learned the hard way

- **Never put `mask`, `filter`, `backdrop-filter`, `opacity < 1` or `clip-path` on an ancestor of the composer.** Chromium treats such an ancestor as a *backdrop root*, and the composer stops blurring. That's why the card's glass lives in `::before`/`::after` layers, and the header fade is a frost on `header::before`, not a mask on the scroll area.
- **Shadows must fit inside `--cf-gap`.** bb clips the centre region, so a wider shadow gets cut off in a straight line.
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
- **Shared glass tokens:** `--cf-glass-fill`, `-blur`, `-highlight` and `-shadow` (in `css.ts`) are the one look for floating panes: the composer and inset sheets. Reuse them; don't invent new values.
- **Swipe actions (`frame/swipe.ts`)** run bb's own actions:
  - Thread row: left archives (the row's own Archive button), right toggles pin (the context menu, opened silently; on touch it's an action sheet).
  - Message: left copies (its Copy button), right quotes into the composer as a synthetic paste. Never simulate Enter, which sends.
  - A thread row is `[data-sidebar-rename-row][role="button"]`; the section wrapper reuses the attribute without the role.
  - Rows are marked `data-no-sidebar-swipe` on `pointerdown` in the capture phase. bb decides its drawer swipe there, before `touchstart`.
  - Never dispatch Escape: it closes bb's drawer.
- **Keyboard-down button:** shown in `[data-promptbox-submit-group]` only while an editor in the composer has focus and the visible area is more than 150px shorter than the window (`html[data-cf-keyboard]`).
- **The search palette is bb's `[data-persistent-drawer-content]`.** On phones it's an inset sheet whose radius is concentric with the screen corners: `--cf-device-radius` (the 16 Pro Max's ~62pt) minus `--cf-sheet-inset`.
- **A blur fades its own edges to transparent.** Blurred layers overhang by 160px (more than 2× the largest blur).
- **The usage bars are not a child of bb's footer icon row.** bb counts that row's children to decide which icons overflow into "…". The bars are positioned over the row's free space, measured from the last visible icon button, with one `ResizeObserver`.
- **Browsers expose no desktop-wallpaper API.** Users upload, paste a URL, or pick from Unsplash.
- **Unsplash terms:** call `download_location` on every new use, add UTM parameters to links, and show the credit.
- **Fonts are installed on the server** (woff2, Latin and Latin Extended, inlined into CSS). Pages make no Google requests; only the picker's previews load from Google.
- **Usage data comes from the `cliproxy-usage` plugin** through `bb.sdk.plugins.callRpc`. That plugin keeps the key.

## Performance

- The backdrop and card blurs paint static images. Never animate anything behind glass.
- The wallpaper is decoded once (`frame/color.ts`, memoised) for both the sidebar tone and the accent.
- The always-on sync uses `frame_light`, a few KB. It fetches the wallpaper (~1 MB) only when `wallpaperId` changes, and fonts only when the set of enabled families changes. That matters when bb is used remotely.
- Style text is only rewritten when it changes, and the last look is cached in localStorage so a reload paints immediately.
- The footer portal re-attaches on a 1s check. Don't observe the whole DOM.

## Work loop

```sh
npx tsc --noEmit -p . && bb plugin build && bb plugin reload calternal-frame
```

Verify visually: `bb browser-automation open --backend local --headless` opens `http://127.0.0.1:38886`. On hd01, Chrome runs from `~/.local/share/bb-chrome` and needs no root. Use `p.shot()`; puppeteer `clip` screenshots re-lay out the page and lie. Test blur with sharp text behind the element.

## kayg's preferences

- Opinionated defaults, with configuration kept in the plugin's settings.
- Details matter: alignment, concentric radii, no stray bands or seams. Check every route with screenshots.
- Atomic commits, pushed to both `origin` (Forgejo) and `github`.

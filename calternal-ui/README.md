# Calternal UI

Calternal UI makes bb look and feel like a native Apple app. Your wallpaper sits behind everything, the sidebars are flat glass on top of it, and the chat floats in the middle as one rounded card.

It only restyles bb. Your threads, settings and data are untouched, and turning the plugin off gives you bb's own look back at once.

## What you get

**The window**
- **Wallpaper behind the sidebars:** your own picture, one from Unsplash, or one from your library. It's blurred once, when you pick it, so scrolling stays smooth.
- **The chat as a floating card:** it has the iPhone's rounded corners, a soft shadow and a gentle fade at the top and bottom edges.
- **Wide chat:** your messages sit on the right with iMessage-style bubble tails, and the agent writes from the left. You can switch back to bb's centred column.
- **Light and dark:** both themes are tuned so that all text stays easy to read, whatever wallpaper you use.

**Controls as pills, like macOS and iOS**
- **Pills:** buttons are round pills, and related buttons sit together in one capsule.
- **Glass:** the pills use clear glass with the same blur as iOS, so you can still see what's behind them.
- **The thread title is a pill:** click it for the thread menu, double-click it to rename the thread.
- **Wordmark:** the top of the sidebar shows your own name for bb ("bb" by default), in a handwriting font you choose. The sidebar button sits at the other end of that row, like in Apple's apps.

**The composer**
- **One tidy row:** model, context, permission and environment.
- **Phones:** it shrinks to a single line until you start typing.
- **Voice input:** shows as a coloured pill with a timer.
- **Attachments:** one row you can swipe sideways, softly faded at the edges.

**Small things that add up**
- **Warm tooltips:** they appear after a short pause. After that, the next one shows instantly.
- **Footer:** New thread and Search live there, next to Settings. The extra "…" menu only appears when your pointer is near it. When the sidebar is narrow, the usage pill shows only the provider of the chat you're in.
- **Clock:** a 24-hour clock everywhere in bb (you can switch to 12-hour).
- **Message times:** every message, yours and the agent's, shows when it was sent.
- **Motion:** animations follow the mouse but never the keyboard, so typing always feels instant.

**On phones**
- **The header:** the thread title sits on the left; the ⋯ menu also holds the right panel, and opening it keeps your keyboard up.
- **The sidebar scrolls as one**, under its name at the top and its buttons at the bottom, with items fading softly as they pass under them.
- **Swipe a thread** left to archive it, right to pin it.
- **Search:** pull down on the chat's title bar, or tap the search button at the top of the sidebar.
- **Swipe sideways** anywhere in a chat: the chat follows your finger, right to open the sidebar, left for the right panel.
- **A keyboard-down button** sits in the composer while you type.

## Install

From this folder:

```sh
npm install
bb plugin build
bb plugin install . --yes
```

Reload bb once after installing.

## Settings

Open **Settings → Plugins → Calternal UI**.

| Section | What you can change |
|---|---|
| Wallpaper | Upload a picture, paste a link, pick from your library or search Unsplash |
| Glass | How strong the blur, tint and dimming are on the sidebars and the chat card |
| Colour & size | Accent colour, interface size, chat layout (wide or centred), clock |
| Fonts | A font for the interface, chat, code and terminal: from Google Fonts, Fontsource, Fontshare, your own font files, or your device's own (SF Pro on Apple) |
| Wordmark | The name at the top of the sidebar and its font |
| Storage | Every wallpaper and font kept on your bb server, with sizes. Remove what you don't need |

## Optional extras

- **Unsplash search:** get a free access key from [unsplash.com/developers](https://unsplash.com/developers) and paste it into the plugin's settings.
- **Usage in the sidebar footer:** install the sibling [cliproxy-usage](../cliproxy-usage/) plugin to see your Claude and Codex usage next to the footer buttons.

## Good to know

- **Fonts and wallpapers are stored on your bb server,** so pages never load anything from Google, Fontsource, Fontshare or Unsplash while you work.
- **Font sources:** [Google Fonts](https://fonts.google.com); [Fontsource](https://fontsource.org) for open fonts Google lacks (Maple Mono, Geist Sans, Monaspace, Iosevka, iA Writer, Open Runde…); [Fontshare](https://www.fontshare.com) (Satoshi, General Sans, Switzer, Clash Display…). Each list's right column shows where a font comes from.
- **SF Pro and SF Mono:** Apple doesn't allow them to be downloaded or shared, so pick **System**: Apple devices then show SF Pro (SF Mono for code), and other devices their own system font.
- **Your own fonts:** under Fonts, **Add your own font…** takes .woff2, .woff, .ttf or .otf files you're licensed to use. Upload several files under one name for its weights and italics (read from the file names, like "Bold" or "SemiboldItalic").
- **Safari before version 26** lacks one CSS feature used in the sidebar footer. A simpler layout takes over there automatically.
- **Reload bb** if something looks unstyled after an update.

## More

- [CHANGELOG.md](CHANGELOG.md): what changed in each release.
- [AGENTS.md](AGENTS.md): how it works inside, and the rules to keep. Written for developers and coding agents.

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
- **Wordmark:** the top of the sidebar shows your own name for bb ("bb" by default), in a handwriting font you choose.

**The composer**
- **One tidy row:** model, context, permission and environment.
- **Phones:** it shrinks to a single line until you start typing.
- **Voice input:** shows as a coloured pill with a timer.

**Small things that add up**
- **Warm tooltips:** they appear after a short pause. After that, the next one shows instantly.
- **Footer:** New thread and Search live there, next to Settings. The extra "…" menu only appears when your pointer is near it.
- **Clock:** a 24-hour clock everywhere in bb (you can switch to 12-hour).
- **Motion:** animations follow the mouse but never the keyboard, so typing always feels instant.

**On phones**
- **Swipe a thread** left to archive it, right to pin it.
- **Swipe a message** right to reply, left to see its time.
- **Pull down** from the top to search.
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
| Fonts | Any Google Font for the interface, chat, code and terminal |
| Wordmark | The name at the top of the sidebar and its font |
| Storage | Every wallpaper and font kept on your bb server, with sizes. Remove what you don't need |

## Optional extras

- **Unsplash search:** get a free access key from [unsplash.com/developers](https://unsplash.com/developers) and paste it into the plugin's settings.
- **Usage in the sidebar footer:** install the sibling [cliproxy-usage](../cliproxy-usage/) plugin to see your Claude and Codex usage next to the footer buttons.

## Good to know

- **Fonts and wallpapers are stored on your bb server,** so pages never load anything from Google or Unsplash while you work.
- **Safari before version 26** lacks one CSS feature used in the sidebar footer. A simpler layout takes over there automatically.
- **Reload bb** if something looks unstyled after an update.

## More

- [CHANGELOG.md](CHANGELOG.md): what changed in each release.
- [AGENTS.md](AGENTS.md): how it works inside, and the rules to keep. Written for developers and coding agents.

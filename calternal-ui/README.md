# Calternal UI

A bb plugin that gives bb calternal's look, after Craft's window:

- **Backdrop:** your wallpaper behind flat sidebars, blurred once (not on every repaint).
- **Chat card:** a floating, tinted glass card with a soft shadow and a frosted composer.
- **Accent:** one accent colour across bb, from the wallpaper or your own.
- **Clock:** 24-hour times everywhere in bb by default (12-hour or the browser's default if you prefer).
- **Light and dark:** both themes measured to WCAG 4.5:1 text contrast.
- **Fonts:** any Google Font for the UI, chat, code and terminal, stored locally.
- **Composer:** one compact bottom row of icons (model, context, permission, environment); one line on phones until you type; voice input as an accent pill with a clock.
- **Sidebar:** compact navigation aligned with the thread list; New thread and Search live in the footer next to Settings.
- **Details:** warm tooltips, iMessage-style bubble tails, glass menus and dialogs.
- **Phones:** swipe a thread to archive or pin, swipe a message to reply or see times, pull down to search, a keyboard-down button.
- **Storage:** every wallpaper and font the plugin keeps is listed in its settings, with sizes, and can be removed.

Everything is configured under **Settings → Plugins → Calternal UI**.

## Install

```sh
npm install
bb plugin build
bb plugin install . --yes
```

## Optional

- **Unsplash wallpaper search:** paste a free access key from [unsplash.com/developers](https://unsplash.com/developers) into the plugin's settings.
- **Usage in the sidebar footer:** install the sibling [cliproxy-usage](../cliproxy-usage/) plugin.

See [AGENTS.md](AGENTS.md) for how it works and the rules to keep.

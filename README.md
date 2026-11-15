# bb-plugins

kayg's plugins for [bb](https://getbb.app). Each plugin lives in its own directory, with its own `package.json`, `README.md` and `AGENTS.md`.

| Plugin | What it does |
|---|---|
| [calternal-frame](calternal-frame/) | Calternal's look for bb: wallpaper backdrop, floating glass chat card, accent colour, Google Fonts, compact composer |
| [cliproxy-usage](cliproxy-usage/) | CLIProxyAPI quota for Claude and Codex: percentages in the sidebar footer, per-account breakdown |

Install a plugin from its directory with `bb plugin build && bb plugin install . --yes`.

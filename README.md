# bb-plugins

kayg's plugins for [bb](https://getbb.app). Each plugin lives in its own directory, with its own `package.json`, `README.md` and `AGENTS.md`.

| Plugin | What it does |
|---|---|
| [calternal-ui](calternal-ui/) | Calternal's look for bb: wallpaper backdrop, floating glass chat card, accent colour, Google Fonts, compact composer and sidebar, light and dark |
| [cliproxy-usage](cliproxy-usage/) | CLIProxyAPI quota for Claude and Codex: percentages in the sidebar footer, per-account breakdown |

Install a plugin from its directory with `bb plugin build && bb plugin install . --yes`. Releases are tagged per plugin (`calternal-ui-v1.0.0`, `cliproxy-usage-v1.0.0`). Notes for coding agents are in [AGENTS.md](AGENTS.md) and in each plugin's own `AGENTS.md`.

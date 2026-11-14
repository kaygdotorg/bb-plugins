# Calternal Frame

A bb plugin that gives bb calternal's frame:

- **Backdrop:** your wallpaper behind flat sidebars.
- **Chat card:** a floating, tinted glass card with a frosted composer.
- **Accent:** one accent colour across bb.
- **Fonts:** any Google Font, stored locally.
- **Usage bars:** small pooled Claude/Codex usage bars in the sidebar footer.

Everything is configured under **Settings → Plugins → Calternal Frame**.

## Install

```sh
npm install
bb plugin build
bb plugin install . --yes
```

## Optional

- **Unsplash wallpaper search:** paste a free access key from [unsplash.com/developers](https://unsplash.com/developers) into the plugin's settings.
- **Usage bars:** need the CLIProxyAPI Usage plugin, configured with your CLIProxyAPI instance.

See [AGENTS.md](AGENTS.md) for how it works and the rules to keep.

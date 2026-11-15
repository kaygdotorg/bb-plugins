# CLIProxyAPI Usage

A bb plugin that shows your CLIProxyAPI accounts' quota windows in the sidebar:

- **Footer:** pooled Claude and Codex usage as percentages, in place of a chart icon. Amber and red mark the danger zones.
- **Breakdown:** click the percentages for every account and its windows (session, weekly, per model) with reset times.

Several accounts of one provider pool into one number: the mean share used, with the soonest reset.

## Install

```sh
npm install
bb plugin build
bb plugin install . --yes
```

## Configure

Under **Settings → Plugins → CLIProxyAPI Usage**:

- **Management URL and key:** a URL reachable from the bb server, and the CLIProxyAPI management key. The key stays on the server.
- **Footer:** on or off, which window (session, weekly, or session then weekly), which providers, icons or names, and the amber and red thresholds.

See [AGENTS.md](AGENTS.md) for how it works.

Changes per release: [CHANGELOG.md](CHANGELOG.md).

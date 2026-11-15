# honcho

[Honcho](https://honcho.dev) memory for bb. It captures every bb conversation, whichever harness runs it (Claude Code, Codex, Pi, ACP), and recalls relevant memory in each thread. A Memory page shows everything it does. The design is in [DESIGN.md](DESIGN.md).

## Install

```sh
cd honcho
npm install
bb plugin build && bb plugin install . --yes
```

The plugin reads `~/.honcho/config.json`, the same file claude-honcho uses, so it needs no setup on a machine that already runs claude-honcho. To override the server, workspace, user peer or key, use the connection settings (`bb plugin config <id> set …` or Settings → Installed plugins). A key set there is stored as a bb secret.

## What it does

- **Capture.** Every bb thread becomes one Honcho session. The session is scoped to its repo, or to its project when there is no repo. Each harness is its own AI peer. Uploads happen in the background, after a short grace window, and never block a turn. Credentials and your own redaction patterns are removed first. Deleting a thread deletes its session.
- **Recall.** At session start, each thread gets a memory summary: your peer card, the scope's conclusions, and notes agents saved. Claude Code and Codex also get per-turn memory: a fast Honcho search runs as the message is dispatched, and the bb hook injects the result into that turn.
- **Tools.** `honcho_chat`, `honcho_search`, `honcho_conclude` and `honcho_conclusions`. Codex gets them only when `codexUseBbTools` is on.
- **CLI.** `bb honcho status`, `bb honcho pause [--project] [--off]`, `bb honcho backfill --dry-run|--start|--stop|--progress`, and `bb honcho harness state|connect|hand-over|undo`.

## The Memory page

Open **Memory** in the sidebar. It has these tabs:
- **activity**: every upload, recall, tool call, deletion, backfill step, harness change and failure.
- **conclusions**: what Honcho has concluded about you. You can search them, confirm the ones agents wrote, or delete them.
- **peers**: which AI peer each harness writes as.
- **privacy**: pauses, the deny list (git remotes and paths), redaction patterns, a box to test redaction on sample text, and what happens when a thread is deleted.
- **connection**: the server, the key level, health and queue, the backfill, and the harness steps.

Each thread's context card shows its memory status (saving, paused, offline, or not captured, with the reason) and the conclusions that came from it.

## Harness steps

Do these on each machine, on the Memory page → connection, or with `bb honcho harness …`:

1. **connect harnesses.** This installs one bb-owned hook in Claude Code and Codex. It does nothing outside bb, because it exits unless bb started the harness. Inside bb it injects per-turn memory and blocks the old honcho MCP tools. It also records Codex's trust for the new hook. If it can't, the step shows `codex untrusted`.
2. **hand over to bb.** This turns off claude-honcho (`honcho@honcho`) and codex-honcho for this machine, and backs up the configs first. From then on, bb is the only thing that writes your conversations to Honcho. Skip this step on a machine where you still run the CLIs outside bb: inside bb they are neutralized anyway.

Each step has its own **undo**, which restores bb's backups for that step. `bb honcho harness undo` undoes both.

Claude Code and Codex threads that were already running keep their harness capture until bb rebuilds their session. Their status says so. Set `captureRequiresSwitchover` off only if you are sure nothing else is writing them.

## Backfill

Run a dry run first, on the connection tab or with `bb honcho backfill --dry-run`. It counts what it would upload and changes nothing. Then start the backfill. It skips what claude-honcho or codex-honcho already wrote, stops at each thread's switch-over, and resumes where it left off. Its rate is set by `backfillMessagesPerMinute` (default 300).

## Development

Run `npx tsc --noEmit`, `npx vitest run` and `bb plugin build`. See [AGENTS.md](AGENTS.md) for the module map and the wiring order.

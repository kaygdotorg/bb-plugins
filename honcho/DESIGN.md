# honcho for bb: design

Status: design agreed through a grill with kayg on 2026-11-15, revised after an adversarial review. No code yet. Decision ids (H1–H44) refer to the grill log; where a later round changed an earlier answer, only the final rule is written here.

## Goal

bb is the one place where Honcho memory gets captured and recalled for every harness bb runs (Claude Code, Codex, Pi, ACP agents). Capture is automatic and never blocks a turn. Recall is fast enough to feel like magic. Everything the plugin does is visible on one Memory page.

Out of v1: the "remember this" message action, the full conclusions review panel, session summaries on archive, memory-aware automations, and the bots UX, which gets its own grill.

## Words

| bb | Honcho | Rule |
|---|---|---|
| — | workspace | one per connection, default `hermes` |
| you | user peer | `hermy` |
| harness (provider) | ai peer | one per harness |
| thread | session | 1:1, session id = thread id |
| repo, or project when there is no repo | scope | one per session |

## Connection and config (H9, H16, H17, H38)

- One active connection. Presets: Honcho cloud (`api.honcho.dev`, key required) and self-hosted (any url, key optional). A test button.
- Zero-config: the plugin reads `~/.honcho/config.json` live. The url comes from `endpoint.baseUrl`, the key from the top-level `apiKey`, and the workspace and peer from `hosts.claude_code`. A rotated key works without touching bb. A bb secret setting (a 0600 file) only overrides. The plugin warns when bb's values and the file disagree.
- The key's level is detected with a probe, because cloud keys are opaque. Scoped and workspace-wide tools need a workspace or admin key; with a narrower key they are disabled, and the connection tab says why.
- Never put a secret in contributed provider env: bb echoes env values verbatim in `provider.env-resolved` timeline events.

## Peers (H2, H13, H36)

- The ai peer is the provider id, with the existing aliases: `claude-code` → `claude_code`, `codex` → `codex`, `pi` → `pi`, and ACP agents → `acp-<agentId>`. The alias map is pinned in tests.
- A provider the plugin hasn't seen gets its peer on first use and shows up in the peers tab. Honcho can't rename or delete peers, so a rename starts a new peer for future messages and the UI says so.
- Only `hermy` is studied: ai peers get `observe_me=false`, so the deriver never models agents. Agent text is still stored and searchable.

## Sessions and scopes (H3, H35, H37, H22)

- Every bb thread is its own session, id = thread id. Metadata: provider, model, host, environment, project, parent thread, origin.
- Side chats get their own session, linked to the parent (`metadata.parentThread`, `metadata.sideChat`). The parent's recall includes them through a metadata filter. Because they are separate sessions, each can be deleted on its own.
- Automation runs:
  - Each run gets its own session, linked by `metadata.automationId`. A run is detected by the `[bb automation due:<id>]` prompt prefix plus `originPluginId`.
  - bb exposes no create or edit event, so the first time a run of an automation is seen, the plugin saves one `hermy` message with reasoning on, of the form "kayg set up <automation>: <schedule>, <prompt>". It saves it again when the prompt changes.
  - Each run's prompt is saved as `hermy` with `metadata.trigger: automation` and reasoning off. Run outputs are saved as the agent's messages. Replies kayg types inside a run are normal `hermy` messages.
  - A run that steers into an existing thread belongs to that thread's session.
- One scope per session: the repo name when the thread runs in git (from the git common dir, so worktrees share it; same format as the Claude Code plugin, so bb and cli sessions share the scope), otherwise the bb project. Host and environment are metadata filters, not scopes. Each named scope is its own observer, so extra scopes would multiply deriver cost. Scope ids are slugged to `^[a-zA-Z0-9_-]+$`.

## Capture (H1, H4, H15, H21, H30, H32, H33, H36)

- The only capture source inside bb is bb's thread event log (`bb.sdk.threads.events.list`), which has the same shape for every provider.
- What is saved:
  - User and agent messages, in full.
  - Tool calls, as one-line summaries (`ran: cargo test`, `edited: src/x.ts`) with reasoning off. Trivial reads (ls, cat, grep, …) and honcho's own tools are dropped.
  - Messages from another thread (`[bb message from thread:…]`): saved and credited to the sender thread's ai peer, never to `hermy`.
  - Prompts a parent agent writes for its workflow children: credited to the parent's ai peer.
- Never saved: reasoning, raw diffs, images and attachments, `provider.env-resolved` events, system-initiated parent messages that repeat child outcomes (`child-completed`, `child-outcome-batch`), and in-thread subagent messages (`agentMessage.parentToolCallId`).
- Workflow children are saved as their own sessions, linked to the parent, with no reasoning.
- Redaction runs before anything is written locally:
  - JWTs, high-entropy strings, URL credentials and PEM blocks;
  - `Authorization:` headers and `export X=` in commands;
  - every key in `~/.honcho/config.json`, and the values in bb-secrets dotenv files;
  - user regex patterns from the privacy tab.
- The outbox holds no content:
  - The sqlite db (`bb.storage.database`) keeps per-thread cursors (`afterSeq`), an in-flight marker and retry state. Content is re-read from the event log when it is sent. The schema is versioned with a migrations table from day one.
  - A 30 s grace window before upload, so pausing or deleting right after pasting something really stops it.
  - Batches of up to 100 messages, each at most 25k chars. Longer content is split in order, and large pastes get reasoning off.
  - Exponential backoff. Capture never blocks a turn.
- Idempotency: Honcho has no idempotency key and messages can't be deleted, so every message carries `metadata.bb_thread` and `metadata.bb_seq`. The in-flight marker is written before each POST. After a crash, the plugin lists that thread's messages by metadata before resending.
- Catch-up: events missed while the plugin was down or reloading are read again from each thread's cursor at startup.
- Switch-over without double capture: a thread is captured only once bb has built its provider session with the harness integrations off. The plugin records a marker and the starting seq. Threads that were already running keep their harness capture until their session is rebuilt.

## Harness handover (H27, H28)

- Per machine, the Memory page's "connect harnesses" button hands honcho over to bb. It:
  - turns off `honcho@honcho` in `~/.claude/settings.json` and removes the honcho hooks and MCP entry from `~/.codex/hooks.json` and `~/.codex/config.toml`, keeping backups and offering a one-click undo;
  - installs one bb-owned global prompt hook in each harness. The hook exits immediately unless bb set its env flag, so it does nothing outside bb.
- After the handover, bb's tools are the only honcho tools in bb threads.
- On a machine where kayg still runs the CLIs outside bb, the integrations stay on, and inside bb they are neutralized instead:
  - Claude: an empty `HONCHO_CONFIG_PATH` plus `HONCHO_API_KEY=""` (claude-honcho 0.4.0 has no on/off key; its hooks quit without a credential). Its MCP tools stay listed but inert, and the bb hook blocks calls to them with "use `honcho_chat`".
  - Codex: `HONCHO_CONFIG_DIR` with `enabled:false` plus `HONCHO_API_KEY=""`. Codex keeps its own honcho MCP (tools only, same workspace), and bb's tools are not registered for codex.
  - Tripwire: after each captured thread's first turn, and whenever the installed claude-honcho version changes, the plugin checks Honcho for a harness-named session for that conversation. A hit raises the error badge.

## Recall (H6, H11, H18, H29, H31)

- At session build, `contributeInstructions` / `configure` inject the peer card, the directives, and a short summary for the thread's scope. The callback reads an in-memory cache only, with no network, and stays within the 32 KiB cap. The cache is refreshed once globally (not per thread) on `thread.active` and every 5 min. The scope summary comes from a scoped `chat` and is cached.
- Per-turn recall, where the harness has a prompt hook (Claude Code, Codex):
  - On `bb.experimental_hooks.on("message.dispatch")` (always `proceed`), the plugin starts a fast Honcho `search` for the prompt text, never `chat`.
  - The plugin's host worker writes the result, keyed by prompt hash, to a cache file in that machine's plugin data dir. No http, and no token in env.
  - The bb hook waits up to a small budget for the entry matching this prompt's hash, then injects it or gives up. It never serves an earlier prompt's result.
  - Pi, ACP and sandboxes without a bb host daemon get session-start recall only.
- Injected memory is framed as background about kayg, not instructions. Conclusions an agent saves are marked as agent-written.

## Tools (H7)

Native bb tools via `bb.agents.registerTool`, the same for every provider except codex on machines that weren't handed over:
- `honcho_chat`: takes a scope, or workspace-wide; `low` reasoning unless the agent asks for more.
- `honcho_search`
- `honcho_conclude`
- `honcho_conclusions`: list, query, delete.

## Privacy and deletion (H5, H24, H34, H40)

- Capture is on by default. The first thread in a new bb project shows a one-time "memory is on for <project> · pause" notice. A deny list by git remote or path glob covers client repos.
- Pause per thread or per project (context card row, Memory page, `bb honcho pause`). Pausing is instant with no confirm. Paused turns are never queued or uploaded, nothing earlier is deleted, and the paused state is clearly marked.
- When a thread is deleted, its session is deleted, together with any queued messages. Honcho finishes the cascade asynchronously and gives no completion signal. "Also purge conclusions learned from this thread" is on by default. The UI says the peer card may reflect the thread until it regenerates. Archiving keeps everything.
- Delete-on-delete is a setting, on by default, with a warning while the storage-retention plugin auto-deletes threads (bb can't tell that apart from a user delete).

## Backfill (H8, H39)

- `bb honcho backfill` is opt-in and run manually. It starts with a dry run that shows threads, messages, tokens and expected deriver load.
- It uses the same capture and redaction rules, the original timestamps, and its own rate limit so live derivation isn't starved. Only `hermy` messages have reasoning on. It is resumable through per-thread cursors.
- It stops at each thread's switch-over marker.
- Dedupe against what the harness integrations already wrote:
  - Claude: sessions are matched by the sanitized session id from `thread/identity.providerThreadId`.
  - Codex `chat-instance` sessions: matched by `folder-<first 8 chars of the codex thread id>`.
  - Older codex `per-directory` sessions: one per folder with many chats mixed in, so they are compared message by message, on text and timestamp.

## UI (H10, H12, H14, H31, H42)

- The Memory page is a `navPanel`: a plugin-owned page with its own left-sidebar entry. Tabs:
  - **activity:** live uploads, recalls, tool calls and failures, each linking to its thread, with a redaction count and reasoning flag;
  - **conclusions:** what honcho believes, with search, delete and confirm;
  - **peers:** the harness → ai-peer map;
  - **privacy:** pauses, the deny list, redaction patterns and a "test on text" box;
  - **connection:** server, key level, health, queue, backfill progress, and the harness handover.
- The bots tab is reserved for v2.
- The sidebar badge shows only on an auth failure, a tripwire hit, or when the oldest unsent item is more than 10 min old. Retries never flash it.
- The thread context card, at the pane's upper right (or the banner in narrow panes):
  - a row: `memory · saving · 4s ago`, `paused`, or `offline · N queued`. Clicking it toggles pause.
  - a section: the top conclusions in this thread's scope, the conclusions this thread created, and a link to the Memory page.
  - When Honcho is down, recall serves the last card, marked stale, and the tools return "honcho offline".

## bb Memory (H20, H41)

A one-time prompt offers to import bb's built-in Memory entries as confirmed, scoped conclusions, then to turn bb Memory off. It never does either silently.

## Build defaults (H43)

Chosen for reliability first, then speed: TypeScript, modelled on bb's built-in Memory plugin, at `honcho/` in this repo, installed privately first. Tests use a mock Honcho plus fixture threads. Functional tests never assert timings. Speed (hook budget, hit rate, upload lag) is measured on `kayg@hd02`.

## Verify during the build

- Whether the codex bridge accepts an MCP-off `-c` arg; if it does, codex machines that weren't handed over can use bb tools too.
- Whether a fork's event log includes copied parent events (that would duplicate side-chat capture).
- The dispatch-to-hook gap and the search latency on hd02, which set the hook budget.

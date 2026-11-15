# honcho for bb: design

Status: design agreed through a grill with kayg on 2026-11-15, and revised after two adversarial reviews. The second review's corrections are folded in below; they change mechanics, not decisions. Build in progress on branch `honcho-v1`. Decision ids (H1–H44) refer to the grill log; where a later round changed an earlier answer, only the final rule is written here.

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
- Zero-config: the plugin reads `~/.honcho/config.json` live. The url, key, workspace and peer come from `hosts.claude_code` first, then from the top level (that's where claude-honcho reads and rotates them). A trailing `/v3` is stripped from the url, because `endpoint.baseUrl` has one and `hosts.claude_code.baseUrl` doesn't. Every key in the file, including `hosts.codex.apiKey`, joins the redaction deny set. A rotated key works without touching bb. A bb secret setting (a 0600 file) only overrides. The plugin warns when bb's values and the file disagree.
- The key's level is detected with a probe, because cloud keys are opaque. Scoped and workspace-wide tools need a workspace or admin key; with a narrower key they are disabled, and the connection tab says why.
- Never put a secret in contributed provider env: bb echoes env values verbatim in `provider.env-resolved` timeline events.

## Peers (H2, H13, H36)

- The ai peer is the provider id, with the existing aliases: `claude-code` → `claude_code`, `codex` → `codex`, `pi` → `pi`, and ACP agents → `acp-<agentId>`. The alias map is pinned in tests.
- A provider the plugin hasn't seen gets its peer on first use and shows up in the peers tab. Honcho can't rename or delete peers, so a rename starts a new peer for future messages and the UI says so.
- Only `hermy` is studied: ai peers get `observe_me=false`, so the deriver never models agents. This is set per session in SessionCreate `peers`, never on the peer itself, because that would also change the claude and codex CLIs, which share the same peer ids. Agent text is still stored and searchable.

## Sessions and scopes (H3, H35, H37, H22)

- Every bb thread is its own session, id = thread id. Metadata: provider, model, host, environment, project, parent thread, origin.
- Side chats get their own session, linked to the parent (`metadata.parentThread`, `metadata.sideChat`). The parent's recall includes them through a metadata filter. Because they are separate sessions, each can be deleted on its own.
- Automation runs:
  - Each run gets its own session, linked by `metadata.automationId`. A run is detected by the `[bb automation due:<id>]` prompt prefix plus `originPluginId`. The schedule and prompt come from the automations plugin's `automations_get` RPC through `bb.sdk.plugins.callRpc`, if cross-plugin calls are allowed; otherwise only the prompt seen is recorded.
  - bb exposes no create or edit event, so the first time a run of an automation is seen, the plugin saves one `hermy` message with reasoning on, of the form "kayg set up <automation>: <schedule>, <prompt>". It saves it again when the prompt changes.
  - Each run's prompt is saved as `hermy` with `metadata.trigger: automation` and reasoning off. Run outputs are saved as the agent's messages. Replies kayg types inside a run are normal `hermy` messages.
  - A run that steers into an existing thread belongs to that thread's session.
- One scope per session: the repo name when the thread runs in git (from the git common dir, so worktrees share it; same format as the Claude Code plugin, so bb and cli sessions share the scope), otherwise the bb project. Host and environment are metadata filters, not scopes. Each named scope is its own observer, so extra scopes would multiply deriver cost. Scope ids are lowercased and slugged (`[^a-z0-9_-]` → `-`), matching claude-honcho. Scopes and peers are passed in SessionCreate, so a session joins its scope before any message and nothing needs the async scope backfill. The scope is computed when the thread is created, from `configure()`'s `environment.path` and `project`, not from inside the synchronous callback.

## Capture (H1, H4, H15, H21, H30, H32, H33, H36)

- The only capture source inside bb is bb's thread event log (`bb.sdk.threads.events.list`), which has the same shape for every provider. Only completed items are read; bb prunes deltas, usage and diffs.
  - User text: `client/turn/requested` (`data.input[]`, `initiator`, `senderThreadId`, `systemMessageKind`), confirmed by `turn/input/accepted`. There is no user-message item.
  - Agent text: `item/completed` items with `type=agentMessage`.
- Forks and side chats copy the parent's completed-turn events into their own log, so their cursor starts after the last copied seq. Otherwise each side chat would upload the whole parent again.
- Editing a message deletes the seqs from the edit point onward and appends a `system/operation` (`edit_message`) event. Queued items whose seq is gone are dropped, not retried. Already-uploaded messages from the old branch get `metadata.bb_superseded` (messages can't be deleted, but their metadata can be updated).
- What is saved:
  - User and agent messages, in full.
  - Tool calls, as one-line summaries (`ran: cargo test`, `edited: src/x.ts`) with reasoning off. Trivial reads (ls, cat, grep, …) and honcho's own tools are dropped.
  - Messages from another thread (`[bb message from thread:…]`): saved and credited to the sender thread's ai peer, never to `hermy`.
  - Prompts a parent agent writes for its workflow children: credited to the parent's ai peer.
- Never saved: reasoning, raw diffs, images and attachments, `provider.env-resolved` events, system-initiated parent messages that repeat child outcomes (`child-completed`, `child-outcome-batch`), and every in-thread subagent item, of any type, that has a `parentToolCallId`.
- Workflow children are saved as their own sessions, linked to the parent, with no reasoning.
- Redaction runs before anything is written locally:
  - JWTs, high-entropy strings, URL credentials and PEM blocks;
  - `Authorization:` headers and `export X=` in commands;
  - every key in `~/.honcho/config.json`, and the values in bb-secrets dotenv files;
  - user regex patterns from the privacy tab.
- The outbox holds no content:
  - The sqlite db (`bb.storage.database`) keeps per-thread cursors (`afterSeq`), an in-flight marker and retry state. Content is re-read from the event log when it is sent. The schema is versioned with a migrations table from day one.
  - A 30 s grace window before upload, so pausing or deleting right after pasting something really stops it. Pauses are stored as seq ranges and checked at send time, so unpausing inside the window never uploads what was typed while paused.
  - Batches of up to 100 messages, each at most 25k chars. Longer content is split in order, and large pastes get reasoning off.
  - Exponential backoff. Capture never blocks a turn.
- Idempotency: Honcho has no idempotency key and messages can't be deleted, so every message carries `metadata.bb_thread`, `metadata.bb_seq` (a number, so range filters work) and `metadata.bb_part` (the chunk index). The in-flight marker is written before each POST. After a crash, the plugin lists that thread's messages by metadata before resending.
- Catch-up: events missed while the plugin was down or reloading are read again from each thread's cursor at startup.
- Switch-over without double capture: a thread is captured only once bb has built its provider session with the harness integrations off. The plugin records a marker and the starting seq. Threads that were already running keep their harness capture until their session is rebuilt.
  - The gate: bb logs `provider.env-resolved` both when it builds a provider session and when a message steers into a running turn, where no new process starts and the harness keeps its old env. So a `BB_HONCHO` env event counts only when it belongs to a real build: since the newest `client/turn/requested`, bb logged `client/thread/start` or `thread/identity`, and no `turn/input/accepted` came first. Checked against real claude and codex threads (2026-11-15): new threads log `client/turn/requested, client/thread/start, thread/identity, provider.env-resolved`; relaunches (and codex app-server resumes, on many turns) log `client/turn/requested, thread/identity, provider.env-resolved`; steers log `client/turn/requested, turn/input/accepted, provider.env-resolved`.
  - Probation: after the switch-over, the thread's uploads wait ("checking the old honcho plugin is quiet") until the first turn after the build has completed and, at least the grace window after its `turn/completed`, the tripwire finds no harness-session message created after the build. A hit drops the marker and records when the harness wrote; only a build after that time can switch the thread over again. Each step is recorded in activity.
  - Markers carry the gate version that made them. At startup, markers from the first gate rule (which trusted steers) are re-evaluated with the current one: moved forward to the real build, or dropped. Cursors stay, since uploads can't be undone, and a tripwire hit the move explains is cleared.

## Harness handover (H27, H28)

- Two separate steps per machine on the Memory page, because machines that weren't handed over still need the hook:
  - **connect harnesses** installs one bb-owned global hook in each harness (a prompt hook, plus a PreToolUse block on the old honcho MCP tools). It is a shell guard that exits before starting node unless bb set its env flag, so it does nothing outside bb.
  - **hand over to bb** turns off `honcho@honcho` in `~/.claude/settings.json`, and removes the honcho hooks and MCP entry from `~/.codex/hooks.json` and `~/.codex/config.toml`. It keeps backups and offers a one-click undo. The codex edit uses a TOML parser or codex-honcho's own `stripBlock`, never a raw delete of the marker block: that block also holds `[tui]`, `hooks.state` trust hashes and `[projects…]`. Codex hook trust (`hooks.state` hashes keyed by hook index) has to be re-granted for the new hook.
  - A project's own `.claude/settings.json` can turn the plugin back on; the tripwire catches that.
- After the handover, bb's tools are the only honcho tools in bb threads.
- On a machine where kayg still runs the CLIs outside bb, the integrations stay on, and inside bb they are neutralized instead:
  - Claude: `HONCHO_CONFIG_PATH` pointed at a nonexistent file in a bb-owned dir. An empty value doesn't work: claude-honcho treats it as unset and falls back to `~/.honcho/config.json`. claude-honcho 0.4.0 has no on/off key; its hooks quit only when they find no credential. Its MCP tools stay listed but inert, and the bb hook blocks calls to them with "use `honcho_chat`".
  - Codex: `HONCHO_CONFIG_DIR` pointed at a bb-owned dir, holding a config with `enabled:false` and no key, created on each host. Codex keeps its own honcho MCP (tools only, same workspace), and bb's tools are not registered for codex.
  - Tripwire: after each captured thread's first turn, and whenever the installed claude-honcho version changes, the plugin checks Honcho for a harness-named session for any of the thread's provider thread ids (a thread can have several, from `thread/identity`). A hit raises the error badge.

## Recall (H6, H11, H18, H29, H31)

- At session build, `contributeInstructions` / `configure` inject the peer card, the directives, and a short summary for the thread's scope. The callback reads an in-memory cache only, with no network, and stays within the 32 KiB cap. The cache is refreshed once globally (not per thread) on `thread.active` and every 5 min. The scope summary comes from `peers/{id}/representation` with `scope`, which needs no llm call. Refreshes are debounced, with a long TTL. Only `configure()` injects; `contributeInstructions` isn't used.
- Per-turn recall, where the harness has a prompt hook (Claude Code, Codex):
  - On `bb.experimental_hooks.on("message.dispatch")`, the plugin returns `proceed` at once, then starts a fast Honcho `search` (about 0.3–0.4 s on honcho.kayg.org), never `chat`.
  - The host worker writes the result to a cache file in that machine's plugin data dir, keyed by `BB_THREAD_ID` plus a dispatch counter, with the normalized prompt text. The hook can't know that dir, so a host RPC reports it and bb passes it as a non-secret env value. The worker is kept warm with `experimental_retainWorker`, since it otherwise cold-starts in up to 10 s after 5 idle minutes. No http, and no token in env.
  - The hook waits up to a small budget for an entry whose hash equals the sha256 of the normalized prompt it received (trim, collapse whitespace, first 500 chars). Matching is strict equality, never "contained in":
    - Candidates are the prompt itself plus versions with only bb's own wrappers stripped: the plugin mention context suffix, leading and trailing attachment markers, and one leading agent-to-agent envelope. Nothing else is removed.
    - Among entries matching a candidate, the highest counter wins. A match is terminal: empty memory means "nothing for this prompt" and the hook exits at once, and a miss never falls back to an earlier prompt's result.
    - The cache file stores hashes only (v2), never prompt text. Steers that join a running turn may not fire the hook at all; they get no per-turn recall.
    - Paused (thread, project, or a side chat's parent) and deny-listed threads get a skip marker, `{"v":2,"skip":true}`, written through the same host op path (`recall.skip`). The hook exits at once on it with no output, so these threads never wait out the budget. The next normal write replaces it.
    - `BB_HONCHO_HOOK_DEBUG=1` makes the hook print one reason line to stderr (`hit`, `miss`, `terminal-empty-match`, `skip-marker`).
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
- When a thread is deleted, its session is deleted, together with any queued messages. Honcho finishes the cascade asynchronously and gives no completion signal. "Also purge conclusions learned from this thread" is on by default. Explicit conclusions already go with the session cascade, but derived ones have no `session_id`. So before the DELETE, the plugin lists the session's conclusions (`filters:{session_id}`), then deletes the derived conclusions whose `source_ids` point at them. The UI says the peer card may reflect the thread until it regenerates. Archiving keeps everything.
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
- The thread context card, at the pane's upper right. It appears only while bb's `threadContextCard` experiment is on; otherwise, and in narrow panes, a banner row shows the same status:
  - a row: `memory · saving · 4s ago`, `paused`, or `offline · N queued`. Clicking it toggles pause.
  - a section: the top conclusions in this thread's scope, the conclusions this thread created, and a link to the Memory page.
  - When Honcho is down, recall serves the last card, marked stale, and the tools return "honcho offline".

## bb Memory (H20, H41)

A one-time prompt offers to import bb's built-in Memory entries as confirmed, scoped conclusions, then to turn bb Memory off. It never does either silently.

## Build defaults (H43)

Chosen for reliability first, then speed: TypeScript, modelled on bb's built-in Memory plugin, at `honcho/` in this repo, installed privately first. Tests use a mock Honcho plus synthetic fixture threads, never real event logs (this repo is public, and real logs hold `provider.env-resolved` values). A secret-scan test fails the build if any file contains a JWT-like or high-entropy token. Functional tests never assert timings. Speed (hook budget, hit rate, upload lag) is measured on `kayg@hd02`.

## Verify during the build

- Whether the codex bridge accepts an MCP-off `-c` arg; if it does, codex machines that weren't handed over can use bb tools too.
- How codex grants hook trust in app-server mode.
- Whether another plugin may call the automations plugin's RPCs.
- Settled: a fork's event log does include copied parent events (see Capture).
- The dispatch-to-hook gap and the search latency on hd02, which set the hook budget.

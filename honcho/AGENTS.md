# honcho: notes for agents

- **Read [DESIGN.md](DESIGN.md) first.** It is the agreed design (kayg, 2026-11-15). Don't change a decision in it without kayg; when kayg changes one, update DESIGN.md in the same commit.
- **No code before kayg confirms the design.**
- **Never print api keys.** `~/.honcho/config.json` holds them at the top level and under `hosts.*`. Mask every key when you inspect it, not just the top-level one.
- **Measure speed on `kayg@hd02`,** not the perf VMs. Functional tests never assert timings.

## Checks

Run all three in `honcho/` before a commit: `npx tsc --noEmit`, `npx vitest run`, `bb plugin build`. `test/package.test.ts` allows only the public SDK, zod, node built-ins and the declared test deps. `test/secret-scan.test.ts` scans the whole `honcho/` tree except `node_modules/` and `dist/`, so fixtures must be synthetic.

## Module map

Entry points:
- `server.ts`: the plugin factory. It only wires the slices, in the order below.
- `host.ts`: the one host entry (`experimental_defineHostEntry`). It implements `lib/host-contract.ts` with recall's and harness's host handlers.
- `app.tsx`: the Memory nav page, the thread context card row and section, and the thread segment.
- `hooks/`: the bb-gated Claude Code and Codex hook (shell guard plus node body). `lib/harness/hook-assets.ts` embeds it; regenerate with `node test/harness/gen-assets.mjs`.

Shared (`lib/`):
- `contract.ts`: the service interfaces and the `RpcMethods` map between the server and the UI.
- `settings.ts`: **every** bb setting, in one `bb.settings.define` call, plus `settingsView` (sync and async views handed to the slices). Add a setting here, never in a slice; bb rejects a key defined twice.
- `deps.ts`: `createDeps`: config (file plus setting overrides), the Honcho client, the outbox and the activity log.
- `host-contract.ts`: the merged host contract and `createHostClient`, the plugin's one host client.
- `config.ts`, `honcho-client.ts`, `mapping.ts`, `transform.ts`, `redact.ts`, `outbox.ts`, `activity.ts`: config file reading, the Honcho v3 client, bb-to-Honcho naming, event-to-message transform, redaction, the durable outbox, and the activity ring buffer.
- `rpc-server.ts`: `registerRpc`, the Memory page's RPC. Peers, privacy and connection live here; the rest delegates to the services.
- `cli.ts`: `registerCli`, `bb honcho status|pause|backfill|harness …`.

Slices (`lib/<slice>/`):
- `capture/`: `createCaptureService`: thread events to Honcho sessions, the switch-over gate, pauses, deletion and the tripwire. It also exports `scopeFor` and `isDenied`, which backfill reuses.
- `recall/`: `createRecallService`, `registerConfigure` (session-start memory), `registerDispatchPrefetch` (the per-turn search that writes the host's recall cache file), and recall's host ops (`recall.write`, `recall.dir`, `recall.gitCommonDir`).
- `tools/`: `registerTools`, the `honcho_*` agent tools. They share recall's store, so they register after `createRecallService`.
- `harness/`: `createHarnessService` (connect, hand over, per-step undo), `registerProviderEnv`, and the harness host ops. All harness file edits run in the host worker on the thread's machine.
- `backfill/`: `createBackfillService`: imports past threads at its own rate. It is resumable, and it stops at each switch-over marker.
- `ui/`: the Memory page tabs and the thread card components.

## Wiring order (server.ts)

1. `defineSettings(bb)` (the only `settings.define`), `settingsView`, then `await view.ready` so configure and the env resolvers never read before the first settings load (until then the view serves the descriptor defaults: codex gets no bb tools). Then `createDeps(bb, { settings })` and `createHostClient(bb)`.
2. Capture: `createCaptureService(bb, { ...deps, settings: view.capture })`.
3. Recall: `createRecallService` (with `view.recall` and the shared host client), then `registerTools`, `registerConfigure` and `registerDispatchPrefetch`.
4. Harness: `createHarnessService`, then `registerProviderEnv` **once**. bb allows one env resolver per provider per plugin, so this resolver owns `BB_HONCHO`, `HONCHO_CONFIG_*`, `BB_HONCHO_RECALL_DIR` and `BB_HONCHO_HOOK_BUDGET_MS`. Recall contributes no env.
5. Backfill: `createBackfillService` with capture's `scopeFor` and `isDenied`, the privacy patterns, and `backfillMessagesPerMinute`.
6. `registerCli(bb, { capture, backfill, harness })`, then `registerRpc(bb, { capture, recall, harness, backfill, deps })`.
7. Start: `capture.start()` and `recall.start()` inside the factory, so their event listeners register at load time. Their stoppers, and `backfill.stop`, go to `bb.onDispose`, which runs them LIFO: backfill, then recall, then capture.

`test/server.test.ts` asserts this registration list. Update it whenever a surface is added.

# honcho: notes for agents

- **Read [DESIGN.md](DESIGN.md) first.** It is the agreed design (kayg, 2026-11-15). Don't change a decision in it without kayg; when kayg changes one, update DESIGN.md in the same commit.
- **No code before kayg confirms the design.**
- **Never print api keys.** `~/.honcho/config.json` holds them at the top level and under `hosts.*`. Mask every key when you inspect it, not just the top-level one.
- **Measure speed on `kayg@hd02`,** not the perf VMs. Functional tests never assert timings.
- **Live management tests use `hermes-test` only.** `test/live-management.test.ts` is opt-in through `HONCHO_TEST_CONFIG` (a private dotenv path); optional `HONCHO_TEST_ADMIN_FILE` supplies a short-lived admin credential through a private JSON file. Never put either file in the repository. The default test suite uses fakes.

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
- `keys.ts`: key metadata, tested replacement through the shared secret setting, and one-time minting. Notes never contain credentials; a temporary admin key is never persisted.
- `groups.ts`: groups, scoped recall and a complete, expiring deletion preview. Confirmation rechecks the snapshot and holds capture leases before deleting; the group stays paused. `outbox.ts` stores group pause intervals, shared by capture, recall and backfill.
- `cli.ts`: `registerCli`, `bb honcho status|pause|backfill|harness …`.

Slices (`lib/<slice>/`):
- `capture/`: `createCaptureService`: thread events to Honcho sessions, the switch-over gate, pauses, deletion and the tripwire. It also exports `scopeFor` (the plugin's one scope resolver) and `isDenied`, which backfill and recall reuse.
- `recall/`: `createRecallService`, `registerConfigure` (session-start memory), `registerDispatchPrefetch` (the per-turn search that writes the host's recall cache file), and recall's one host op (`recall.write`). Recall has no scope logic of its own: it reads capture's `knownScope` and asks capture's `scopeFor`.
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
7. Start: `capture.listen()` inside the factory, so the event listeners register at load time. The work that talks to Honcho runs as background services, which bb starts only once the generation is live and aborts first on teardown: `capture-reconcile` (startup catch-up: pending deletes, interrupted uploads, every thread's cursor) and `recall-refresh` (the 5 min cache refresh). The stoppers (`capture.stop`, `recall.stop`, `backfill.stop`) go to `bb.onDispose`, which runs them LIFO: backfill, then recall, then capture. A service abort alone never stops a slice, because bb also aborts and restarts a crashed service.
8. Reload overlap: the old generation can still be uploading while the new one catches up. Every capture upload, and every in-flight-marker recovery, runs under a per-thread lease in the outbox db (`leases`: owner = a random id per generation, expiry 60 s, renewed before each POST, released after). A thread whose lease another generation holds is retried 5 s later; a dead generation's lease expires, and the next holder recovers its in-flight marker by listing what landed.

`test/server.test.ts` asserts this registration list. Update it whenever a surface is added.

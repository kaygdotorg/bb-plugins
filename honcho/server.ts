import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBackfillService } from "./lib/backfill/index.js";
import { createCaptureService } from "./lib/capture/index.js";
import { registerCli } from "./lib/cli.js";
import { createDeps } from "./lib/deps.js";
import { createHarnessService, registerProviderEnv, type HarnessCaller } from "./lib/harness/index.js";
import { createHostClient } from "./lib/host-contract.js";
import { createRecallService, registerConfigure, registerDispatchPrefetch } from "./lib/recall/index.js";
import { readPrivacy, registerRpc } from "./lib/rpc-server.js";
import { defineSettings, settingsView } from "./lib/settings.js";
import { registerTools } from "./lib/tools/index.js";

/** Bad user patterns are refused when saved; any that slip through are skipped, never fatal. */
function compile(patterns: readonly string[]): RegExp[] {
  return patterns.flatMap(p => { try { return [new RegExp(p)]; } catch { return []; } });
}

/** bb expects a service's start to resolve when its signal aborts. */
const aborted = (signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true });
});

/**
 * Wiring order (see AGENTS.md): settings and shared deps, then capture, recall
 * (+ tools, configure, dispatch prefetch), harness (+ the one env resolver per
 * provider), backfill, CLI, RPC; then capture's listeners, the background services
 * (capture's catch-up, recall's refresh), and the stoppers in bb.onDispose, which
 * runs them LIFO on reload, disable and shutdown.
 */
export default async function plugin(bb: BbPluginApi): Promise<void> {
  // 1. The only bb.settings.define call, and the shared deps built on it.
  const settings = defineSettings(bb);
  const view = settingsView(settings);
  // configure() and the env resolvers are synchronous readers of the view:
  // load the stored values before either can be called (get() is load-safe).
  await view.ready;
  const deps = createDeps(bb, { settings });
  // The one host client, over the merged contract host.ts implements.
  const host = createHostClient(bb);

  // 2. Capture.
  const capture = createCaptureService(bb, { ...deps, settings: view.capture });

  // 3. Recall. The service creates the store the tools share, so it comes first.
  // One scope resolver: recall searches the scope capture created the session in.
  const recall = createRecallService(bb, { ...deps, recall: {
    settings: view.recall, host,
    scopeFor: threadId => capture.knownScope(threadId),
    resolveScope: thread => capture.scopeFor(thread),
  } });
  registerTools(bb, deps);
  registerConfigure(bb, deps, recall);
  registerDispatchPrefetch(bb, deps, recall);

  // 4. Harness, and its env resolvers (BB_HONCHO, HONCHO_CONFIG_*, the recall dir, the hook budget).
  const call: HarnessCaller = (op, input, hostId) => host.call(op, input as never, { hostId }) as never;
  const harness = createHarnessService(bb, { activity: deps.activity, call });
  registerProviderEnv(bb, { activity: deps.activity, call, hookBudgetMs: view.hookBudgetMs });

  // 5. Backfill, with capture's scope resolver and deny list so both agree.
  const backfill = createBackfillService(bb, {
    ...deps,
    scopeFor: thread => capture.scopeFor(thread),
    isDenied: thread => capture.isDenied(thread),
    redaction: async () => ({ patterns: compile((await readPrivacy(bb.storage.kv)).patterns) }),
    messagesPerMinute: view.backfillMessagesPerMinute,
  });

  // 6. CLI and the Memory page's RPC.
  registerCli(bb, { capture, backfill, harness });
  registerRpc(bb, { capture, recall, harness, backfill, deps });

  // 7. Start. Event listeners register now, inside the factory, as bb requires.
  // The work that talks to Honcho runs as background services, which bb starts
  // only once this generation is live and aborts first when it is torn down, so
  // a reload's catch-up doesn't start inside the candidate. Capture's per-thread
  // upload lease (lib/outbox.ts) keeps the two generations from posting the same
  // thread while the old one finishes an upload. A crashed service is restarted,
  // so an abort only ends that run; the stoppers are dispose hooks, LIFO:
  // backfill, then recall, then capture.
  capture.listen();
  bb.background.service("capture-reconcile", { start: async signal => { await capture.reconcile(signal); await aborted(signal); } });
  bb.background.service("recall-refresh", { start: signal => recall.run(signal) });
  bb.onDispose(() => capture.stop());
  bb.onDispose(() => recall.stop());
  bb.onDispose(() => backfill.stop());
}

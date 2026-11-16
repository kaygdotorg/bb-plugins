import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBackfillService } from "./lib/backfill/index.js";
import { createCaptureService } from "./lib/capture/index.js";
import { registerCli } from "./lib/cli.js";
import { createDeps } from "./lib/deps.js";
import { createHarnessService, registerAcpProviderEnv, registerProviderEnv, type HarnessCaller } from "./lib/harness/index.js";
import { createHostClient } from "./lib/host-contract.js";
import { createRecallService, registerConfigure, registerDispatchPrefetch } from "./lib/recall/index.js";
import { readPrivacy, registerRpc } from "./lib/rpc-server.js";
import { createSecretsService, secretRequestPaths } from "./lib/secrets.js";
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

  // bb-secrets dotenv values, as an in-memory redaction deny set (never logged or stored).
  // secret-request events are the only record of where bb-secrets wrote a dotenv file.
  const secretPaths = new Set<string>();
  const scanned = new Map<string, number>();
  async function discoverSecretPaths(): Promise<string[]> {
    for (const thread of await bb.sdk.threads.list()) {
      try {
        for (let after = scanned.get(thread.id) ?? 0; ;) {
          const page = await bb.sdk.threads.events.list({ threadId: thread.id, afterSeq: String(after), limit: "100", order: "asc", types: ["system/interaction/lifecycle"] });
          for (const event of page) for (const p of secretRequestPaths(event)) secretPaths.add(p);
          if (page.length) { after = page[page.length - 1].seq; scanned.set(thread.id, after); }
          if (page.length < 100) break;
        }
      } catch { /* unreadable thread: skip */ }
    }
    return [...secretPaths];
  }
  const secrets = createSecretsService({
    host,
    paths: discoverSecretPaths,
    hostIds: async () => (await bb.sdk.hosts.list()).filter(h => h.lifecycle.phase === "active").map(h => h.id),
  });
  const secretValues = () => secrets.values();
  bb.onDispose(secrets.start());

  // 2. Capture.
  // Recall is created after capture, so the purge hook binds to it late.
  let recallForPurge: { conclusionsForThread(threadId: string): Array<{ id: string; attached: boolean }> } | undefined;
  const capture = createCaptureService(bb, {
    ...deps, settings: view.capture, extraDeny: secretValues,
    // The harness service is created below; capture only asks it later, when a thread is processed.
    harnessState: machineId => harness.state(machineId),
    unattachedConclusions: threadId => (recallForPurge?.conclusionsForThread(threadId) ?? []).filter(c => !c.attached).map(c => c.id),
  });

  const codexHandedOverHosts = new Set<string>();
  // 3. Recall. The service creates the store the tools share, so it comes first.
  // One scope resolver: recall searches the scope capture created the session in.
  const recall = createRecallService(bb, { ...deps, recall: {
    settings: view.recall, host,
    scopeFor: threadId => capture.knownScope(threadId),
    resolveScope: thread => capture.scopeFor(thread),
    // Recall and the tools skip deny-listed threads exactly as capture does.
    isDenied: thread => capture.isDenied(thread),
    // bb-secrets values are redacted from search queries, cached memory and honcho_conclude.
    secretValues,
    // After "hand over" on a host, codex has no honcho MCP left, so it gets bb's tools there.
    codexHandedOver: hostId => codexHandedOverHosts.has(hostId ?? ""),
  } });
  recallForPurge = recall;
  registerTools(bb, deps);
  registerConfigure(bb, deps, recall);
  registerDispatchPrefetch(bb, deps, recall);

  // 4. Harness, and its env resolvers (BB_HONCHO, HONCHO_CONFIG_*, the recall dir, the hook budget).
  const call: HarnessCaller = (op, input, hostId) => host.call(op, input as never, { hostId }) as never;
  const harness = createHarnessService(bb, { activity: deps.activity, call });
  // Hosts where codex is handed over (sync for configure). Refreshed at start, every 2 min, and on harness activity.
  const refreshHandedOver = async () => {
    try {
      const hosts = await bb.sdk.hosts.list();
      for (const h of hosts as Array<{ id: string }>) {
        const state = await harness.state(h.id).catch(() => null);
        if (!state) continue;
        if (state.codex.handedOver) codexHandedOverHosts.add(h.id); else codexHandedOverHosts.delete(h.id);
      }
    } catch { /* keep the last answer */ }
  };
  void refreshHandedOver();
  const handedOverTimer = setInterval(() => void refreshHandedOver(), 120_000);
  bb.onDispose(() => clearInterval(handedOverTimer));
  bb.onDispose(deps.activity.subscribe(e => { if (e.kind === "harness") void refreshHandedOver(); }));
  registerProviderEnv(bb, { activity: deps.activity, call, hookBudgetMs: view.hookBudgetMs });
  registerAcpProviderEnv(bb);

  // 5. Backfill, with capture's scope resolver and deny list so both agree.
  const backfill = createBackfillService(bb, {
    ...deps,
    scopeFor: thread => capture.scopeFor(thread),
    isDenied: thread => capture.isDenied(thread),
    redaction: async () => ({ patterns: compile((await readPrivacy(bb.storage.kv)).patterns), deny: await secretValues() }),
    messagesPerMinute: view.backfillMessagesPerMinute,
    captureRequiresSwitchover: async () => (await view.capture()).captureRequiresSwitchover,
  });

  // 6. CLI and the Memory page's RPC.
  registerCli(bb, { capture, backfill, harness });
  registerRpc(bb, { capture, recall, harness, backfill, deps, secrets: secretValues });

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

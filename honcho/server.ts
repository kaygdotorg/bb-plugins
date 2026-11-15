import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createBackfillService } from "./lib/backfill/index.js";
import { createCaptureService } from "./lib/capture/index.js";
import { registerCli } from "./lib/cli.js";
import { createDeps } from "./lib/deps.js";
import { createHarnessService, registerProviderEnv, type HarnessCaller } from "./lib/harness/index.js";
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

/**
 * Wiring order (see AGENTS.md): settings and shared deps, then capture, recall
 * (+ tools, configure, dispatch prefetch), harness (+ the one env resolver per
 * provider), backfill, CLI, RPC; then the long-running parts start and their
 * stoppers go to bb.onDispose, which runs them LIFO on reload, disable and shutdown.
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
          const page = await bb.sdk.threads.events.list({ threadId: thread.id, afterSeq: String(after), limit: "200", order: "asc", types: ["system/interaction/lifecycle"] });
          for (const event of page) for (const p of secretRequestPaths(event)) secretPaths.add(p);
          if (page.length) { after = page[page.length - 1].seq; scanned.set(thread.id, after); }
          if (page.length < 200) break;
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
  const capture = createCaptureService(bb, { ...deps, settings: view.capture, extraDeny: secretValues });

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
    redaction: async () => ({ patterns: compile((await readPrivacy(bb.storage.kv)).patterns), deny: await secretValues() }),
    messagesPerMinute: view.backfillMessagesPerMinute,
  });

  // 6. CLI and the Memory page's RPC.
  registerCli(bb, { capture, backfill, harness });
  registerRpc(bb, { capture, recall, harness, backfill, deps, secrets: secretValues });

  // 7. Start. Listeners register now, inside the factory; the work they
  // schedule runs later. Disposal is LIFO: backfill stops first, capture last.
  const stopCapture = capture.start();
  bb.onDispose(stopCapture);
  const stopRecall = recall.start();
  bb.onDispose(stopRecall);
  bb.onDispose(() => backfill.stop());
}

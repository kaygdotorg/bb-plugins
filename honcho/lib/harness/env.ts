// Provider env for bb-run harnesses. Non-secret by rule: bb echoes every value
// into `provider.env-resolved` timeline events.
import type { BbPluginApi, ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import type { ActivityLog } from "../contract.js";
import type { EnvPaths } from "./ops.js";
import { clampHookBudget, DEFAULT_HOOK_BUDGET_MS } from "../recall/ports.js";
import { harnessHostCaller, type HarnessCaller } from "./service.js";

export { DEFAULT_HOOK_BUDGET_MS };
/** bb drops a resolver after 5 s; give up first so the harness still starts. */
const HOST_CALL_TIMEOUT_MS = 4_000;
const REFRESH_MS = 5 * 60_000;
const FAILURE_REPORT_MS = 5 * 60_000;

export interface ProviderEnvDeps {
  activity?: ActivityLog;
  call?: HarnessCaller;
  /** The shared `hookBudgetMs` setting, read on every resolve so a change applies to the next harness start. */
  hookBudgetMs?: number | (() => number);
  /** Test seam for the cache clock. */
  now?: () => number;
}

const entry = (name: string, value: string, reason: string): ExperimentalPluginProviderEnvEntry => ({ name, value, reason });
const gateEntry = entry("BB_HONCHO", "1", "Turns on the bb honcho hook inside bb-run harnesses");

export function registerProviderEnv(bb: Pick<BbPluginApi, "providers" | "hosts">, deps: ProviderEnvDeps = {}): void {
  const now = deps.now ?? Date.now;
  let caller = deps.call;
  const call: HarnessCaller = (op, input, hostId) => (caller ??= harnessHostCaller(bb))(op, input, hostId);
  const cache = new Map<string, { at: number; value: EnvPaths }>();
  const inflight = new Map<string, Promise<EnvPaths>>();
  const lastFailure = new Map<string, number>();
  const budget = () => {
    const value = typeof deps.hookBudgetMs === "function" ? deps.hookBudgetMs() : deps.hookBudgetMs;
    return String(clampHookBudget(value));
  };

  function fetchPaths(hostId: string): Promise<EnvPaths> {
    let pending = inflight.get(hostId);
    if (!pending) {
      pending = call("harnessEnv", {}, hostId)
        .then((value) => { cache.set(hostId, { at: now(), value }); return value; })
        .finally(() => inflight.delete(hostId));
      inflight.set(hostId, pending);
    }
    return pending;
  }

  /** Cached per host; refreshed in the background so the codex config is re-created if deleted. */
  async function paths(hostId: string): Promise<EnvPaths | null> {
    const hit = cache.get(hostId);
    if (hit) {
      if (now() - hit.at > REFRESH_MS) fetchPaths(hostId).catch(() => undefined);
      return hit.value;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        fetchPaths(hostId),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("host did not answer in time")), HOST_CALL_TIMEOUT_MS); }),
      ]);
    } catch (error) {
      const last = lastFailure.get(hostId) ?? -Infinity;
      if (now() - last > FAILURE_REPORT_MS) {
        lastFailure.set(hostId, now());
        deps.activity?.record({ kind: "failure", summary: `harness env unavailable on ${hostId}; honcho hooks stay off for this start`, error: error instanceof Error ? error.message : String(error) });
      }
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const hookEnv = (p: EnvPaths) => [
    gateEntry,
    entry("BB_HONCHO_RECALL_DIR", p.recallDir, "Where the bb honcho hook reads per-turn recall"),
    entry("BB_HONCHO_HOOK_BUDGET_MS", budget(), "How long the bb honcho hook waits for recall"),
  ];

  // Without the paths, contribute nothing: the hook stays off and claude-honcho /
  // codex-honcho keep working as they do outside bb, rather than half-configured.
  bb.providers.experimental_contributeEnv("claude-code", async ({ hostId }) => {
    const p = await paths(hostId);
    if (!p) return [];
    return [
      ...hookEnv(p),
      entry("HONCHO_CONFIG_PATH", p.claudeConfigPath, "Points claude-honcho at a nonexistent file so it finds no credential inside bb"),
      entry("HONCHO_API_KEY", "", "Clears a shell-exported key, which claude-honcho would otherwise prefer"),
    ];
  });
  bb.providers.experimental_contributeEnv("codex", async ({ hostId }) => {
    const p = await paths(hostId);
    if (!p) return [];
    return [...hookEnv(p), entry("HONCHO_CONFIG_DIR", p.codexConfigDir, "Points codex-honcho at a bb-owned config with enabled:false")];
  });
  bb.providers.experimental_contributeEnv("pi", () => [gateEntry]);
}

/**
 * bb matches env resolvers by exact provider id, so every `acp-*` provider needs
 * its own BB_HONCHO=1 resolver. Checked at start and on each
 * provider-registrations-changed event; each id is registered once for the life
 * of the plugin. A failed provider list is retried at the next event.
 */
export function registerAcpProviderEnv(bb: Pick<BbPluginApi, "providers" | "sdk" | "onDispose">): void {
  const registered = new Set<string>();
  let stopped = false;
  async function check(): Promise<void> {
    let providers: Awaited<ReturnType<BbPluginApi["sdk"]["providers"]["list"]>>;
    try {
      providers = await bb.sdk.providers.list();
    } catch {
      return;
    }
    if (stopped) return;
    for (const { id } of providers) {
      if (!id.startsWith("acp-") || registered.has(id)) continue;
      registered.add(id);
      bb.providers.experimental_contributeEnv(id, () => [gateEntry]);
    }
  }
  const unsubscribe = bb.sdk.subscribe({
    event: "system:changed",
    callback: (event) => { if (event.changes.includes("provider-registrations-changed")) void check(); },
  });
  bb.onDispose(() => { stopped = true; unsubscribe(); });
  void check();
}

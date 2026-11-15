// RPC surface for the Memory page and the thread context card. Delegates to the slice
// services; peers, privacy and connection are small enough to live here.

import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi, type StandardSchemaV1 } from "@get-bb/plugin-sdk";
import type {
  ActivityKind, BackfillService, CaptureService, ConnectionView, Deps, HarnessService,
  PrivacySettings, RecallService, RpcMethods,
} from "./contract.js";
import { redact } from "./redact.js";
import { PROVIDER_PEERS } from "./mapping.js";

export interface Services {
  capture: CaptureService;
  recall: RecallService;
  harness: HarnessService;
  backfill: BackfillService;
  deps: Deps;
}

// The host validates against these; the contract types already describe the shapes, and the
// handlers return JSON-safe values, so the schema only carries the types.
function typed<T>(): StandardSchemaV1<T, T> {
  return { "~standard": { version: 1, vendor: "honcho", validate: (value) => ({ value: value as T }) } };
}
type Entry<K extends keyof RpcMethods> = { input: StandardSchemaV1<RpcMethods[K][0], RpcMethods[K][0]>; output: StandardSchemaV1<RpcMethods[K][1], RpcMethods[K][1]> };
const method = <K extends keyof RpcMethods>(_name: K): Entry<K> => ({ input: typed<RpcMethods[K][0]>(), output: typed<RpcMethods[K][1]>() });

export const rpcContract = defineRpcContract({
  "thread.status": method("thread.status"),
  "thread.context": method("thread.context"),
  "pause.set": method("pause.set"),
  "pause.list": method("pause.list"),
  "health": method("health"),
  "activity.list": method("activity.list"),
  "conclusions.list": method("conclusions.list"),
  "conclusions.delete": method("conclusions.delete"),
  "conclusions.confirm": method("conclusions.confirm"),
  "peers.list": method("peers.list"),
  "peers.rename": method("peers.rename"),
  "privacy.get": method("privacy.get"),
  "privacy.set": method("privacy.set"),
  "privacy.test": method("privacy.test"),
  "connection.get": method("connection.get"),
  "connection.test": method("connection.test"),
  "harness.state": method("harness.state"),
  "harness.connect": method("harness.connect"),
  "harness.handOver": method("harness.handOver"),
  "harness.undo": method("harness.undo"),
  "backfill.dryRun": method("backfill.dryRun"),
  "backfill.start": method("backfill.start"),
  "backfill.progress": method("backfill.progress"),
  "backfill.stop": method("backfill.stop"),
});

// ---------- peers ----------

const PEERS_KEY = "ui.peers";
interface PeerStore { renames: Record<string, string>; firstSeen: Record<string, number> }
type Kv = BbPluginApi["storage"]["kv"];

async function readPeers(kv: Kv): Promise<PeerStore> {
  const stored = await kv.get<Partial<PeerStore>>(PEERS_KEY);
  return { renames: { ...(stored?.renames ?? {}) }, firstSeen: { ...(stored?.firstSeen ?? {}) } };
}

/** The ai peer for a provider: a rename wins, then the built-in alias, then the id itself. */
export async function resolvePeer(kv: Kv, providerId: string): Promise<string> {
  return (await readPeers(kv)).renames[providerId] ?? PROVIDER_PEERS[providerId as keyof typeof PROVIDER_PEERS] ?? providerId;
}

/** Called by capture the first time a provider shows up, so the peers tab can say since when. */
export async function recordProviderSeen(kv: Kv, providerId: string, now = Date.now()): Promise<void> {
  const store = await readPeers(kv);
  if (store.firstSeen[providerId] !== undefined) return;
  store.firstSeen[providerId] = now;
  await kv.set(PEERS_KEY, store);
}

export async function listPeers(kv: Kv): Promise<RpcMethods["peers.list"][1]> {
  const store = await readPeers(kv);
  const ids = [...new Set([...Object.keys(PROVIDER_PEERS), ...Object.keys(store.renames), ...Object.keys(store.firstSeen)])];
  return ids.map((providerId) => ({
    providerId,
    peer: store.renames[providerId] ?? PROVIDER_PEERS[providerId as keyof typeof PROVIDER_PEERS] ?? providerId,
    firstSeen: store.firstSeen[providerId] ?? null,
  }));
}

// ---------- privacy ----------

const PRIVACY_KEY = "ui.privacy";
export const PRIVACY_DEFAULTS: PrivacySettings = {
  denyRemotes: [], denyPaths: [], patterns: [], deleteOnDelete: true, purgeConclusionsOnDelete: true,
};

export async function readPrivacy(kv: Kv): Promise<PrivacySettings> {
  const stored = await kv.get<Partial<PrivacySettings>>(PRIVACY_KEY);
  return { ...PRIVACY_DEFAULTS, ...(stored ?? {}) };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean))] : [];

function compilePatterns(patterns: readonly string[]): RegExp[] {
  return patterns.map((source) => {
    try { return new RegExp(source); }
    catch { throw new experimental_PluginRpcRefusal({ code: "invalid", message: `Not a valid regular expression: ${source}` }); }
  });
}

// ---------- connection ----------

const PROBE_TTL_MS = 60_000;

function presetFor(baseUrl: string): ConnectionView["preset"] {
  try { return new URL(baseUrl).hostname.endsWith("honcho.dev") ? "cloud" : "self-hosted"; } catch { return "self-hosted"; }
}

export function registerRpc(bb: BbPluginApi, services: Services): () => void {
  const { capture, recall, harness, backfill, deps } = services;
  const kv = bb.storage.kv;
  const ok = { ok: true } as const;
  /** Tells open pages that durable state changed; they refetch over rpc. */
  const changed = (what: string) => { try { bb.realtime.publish("changed", { what }); } catch { /* best effort */ } };

  let probe: { at: number; level: ConnectionView["keyLevel"] } | null = null;
  async function keyLevel(force = false): Promise<ConnectionView["keyLevel"]> {
    if (!force && probe && Date.now() - probe.at < PROBE_TTL_MS) return probe.level;
    let level: ConnectionView["keyLevel"] = "unknown";
    try { level = await (await deps.client()).probeKeyLevel(); } catch { /* offline or auth: unknown */ }
    probe = { at: Date.now(), level };
    return level;
  }

  bb.rpc.register(rpcContract, {
    "thread.status": ({ threadId }) => capture.threadStatus(threadId),
    "thread.context": ({ threadId }) => recall.threadContext(threadId),
    "pause.set": async ({ kind, id, paused }) => { await capture.setPaused({ kind, id }, paused); changed("pause"); return ok; },
    "pause.list": () => capture.pauses(),
    "health": () => capture.health(),
    "activity.list": (input) => deps.activity.list(input),
    "conclusions.list": (input) => recall.conclusions(input),
    "conclusions.delete": async ({ id }) => { await recall.deleteConclusion(id); changed("conclusions"); return ok; },
    "conclusions.confirm": async ({ id }) => { await recall.confirmConclusion(id); changed("conclusions"); return ok; },

    "peers.list": () => listPeers(kv),
    "peers.rename": async ({ providerId, peer }) => {
      const name = peer.trim();
      if (!providerId.trim() || !/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Peer ids use letters, digits, - and _." });
      }
      const store = await readPeers(kv);
      store.renames[providerId] = name;
      store.firstSeen[providerId] ??= Date.now();
      await kv.set(PEERS_KEY, store);
      changed("peers");
      return ok;
    },

    "privacy.get": () => readPrivacy(kv),
    "privacy.set": async (patch) => {
      const next = await readPrivacy(kv);
      if (patch.denyRemotes) next.denyRemotes = strings(patch.denyRemotes);
      if (patch.denyPaths) next.denyPaths = strings(patch.denyPaths);
      if (patch.patterns) { next.patterns = strings(patch.patterns); compilePatterns(next.patterns); }
      if (typeof patch.deleteOnDelete === "boolean") next.deleteOnDelete = patch.deleteOnDelete;
      if (typeof patch.purgeConclusionsOnDelete === "boolean") next.purgeConclusionsOnDelete = patch.purgeConclusionsOnDelete;
      await kv.set(PRIVACY_KEY, next);
      changed("privacy");
      return next;
    },
    "privacy.test": async ({ text }) => {
      const privacy = await readPrivacy(kv);
      const { keys } = await deps.config();
      return redact(text, { deny: keys, patterns: compilePatterns(privacy.patterns) });
    },

    "connection.get": async (): Promise<ConnectionView> => {
      const { config, warnings } = await deps.config();
      return {
        preset: presetFor(config.baseUrl),
        baseUrl: config.baseUrl,
        workspace: config.workspace,
        peerName: config.peerName,
        keySource: !config.apiKey ? "none" : warnings.some((w) => w.startsWith("bb apiKey")) ? "bb-secret" : "config-file",
        keyLevel: config.apiKey ? await keyLevel() : "unknown",
        warnings,
      };
    },
    "connection.test": async () => {
      const started = Date.now();
      try {
        const level = await (await deps.client()).probeKeyLevel();
        probe = { at: Date.now(), level };
        return { ok: true, latencyMs: Date.now() - started };
      } catch (error) {
        const kind = (error as { kind?: string }).kind;
        return { ok: false, latencyMs: null, error: kind === "auth" ? "key rejected" : kind === "offline" ? "unreachable" : "request failed" };
      }
    },

    "harness.state": ({ machineId }) => harness.state(machineId),
    "harness.connect": async ({ machineId }) => { const s = await harness.connect(machineId); changed("harness"); return s; },
    "harness.handOver": async ({ machineId }) => { const s = await harness.handOver(machineId); changed("harness"); return s; },
    "harness.undo": async ({ machineId, step }) => {
      if (step !== undefined && step !== "connect" && step !== "handOver") throw new experimental_PluginRpcRefusal({ code: "invalid", message: "step is connect or handOver." });
      const s = await harness.undo(machineId, step); changed("harness"); return s;
    },

    "backfill.dryRun": (input) => backfill.dryRun(input),
    "backfill.start": async (input) => { await backfill.start(input); changed("backfill"); return ok; },
    "backfill.progress": () => backfill.progress(),
    "backfill.stop": async () => { await backfill.stop(); changed("backfill"); return ok; },
  });

  // Realtime: one signal per activity entry; the UI refetches over rpc. Signals are ephemeral,
  // so the UI also polls slowly and refetches when the socket reconnects.
  const unsubscribe = deps.activity.subscribe((entry) => {
    try { bb.realtime.publish("activity", { id: entry.id, kind: entry.kind as ActivityKind, threadId: entry.threadId ?? null }); }
    catch { /* a failed signal must never break the writer */ }
  });
  bb.onDispose(unsubscribe);
  return unsubscribe;
}

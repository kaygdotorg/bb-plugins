// RPC surface for the Memory page and the thread context card. Delegates to the slice
// services; peers, privacy and connection are small enough to live here.

import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi, type StandardSchemaV1 } from "@get-bb/plugin-sdk";
import type {
  ActivityKind, BackfillService, CaptureService, ConnectionView, Deps, HarnessService,
  PrivacySettings, RecallService, RpcMethods,
} from "./contract.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { redact } from "./redact.js";
import { PROVIDER_PEERS } from "./mapping.js";

export interface Services {
  capture: CaptureService;
  recall: RecallService;
  harness: HarnessService;
  backfill: BackfillService;
  deps: Deps & { isCloud(): Promise<boolean> };
  /** bb-secrets values for redaction (privacy.test). */
  secrets?: () => Promise<string[]>;
}

// Output schemas only carry the types (handlers return JSON-safe values). Inputs are real zod schemas.
function typed<T>(): StandardSchemaV1<T, T> {
  return { "~standard": { version: 1, vendor: "honcho", validate: (value) => ({ value: value as T }) } };
}
const text = (max = 2_000) => z.string().min(1).max(max);
const empty = z.preprocess((value) => value ?? {}, z.object({}).loose());
const machine = z.object({ machineId: text(200).optional() });
const stringList = z.array(z.string().max(2_000)).max(500);
export const rpcInputs = {
  "thread.status": z.object({ threadId: text(200) }),
  "thread.context": z.object({ threadId: text(200) }),
  "pause.set": z.object({ kind: z.enum(["thread", "project"]), id: text(2_000), paused: z.boolean() }),
  "pause.list": empty,
  "health": empty,
  "activity.list": z.object({
    limit: z.number().int().min(1).max(1_000).optional(), threadId: text(200).optional(),
    kinds: z.array(z.enum(["upload", "recall", "tool", "delete", "backfill", "harness", "failure"])).max(7).optional(),
  }),
  "conclusions.list": z.object({ query: z.string().max(2_000).optional(), scope: z.string().max(200).optional(), limit: z.number().int().min(1).max(1_000).optional() }),
  "conclusions.delete": z.object({ id: text(200) }),
  "conclusions.confirm": z.object({ id: text(200) }),
  "peers.list": empty,
  "peers.rename": z.object({ providerId: text(200), peer: z.string().max(200) }),
  "privacy.get": empty,
  "privacy.set": z.object({
    denyRemotes: stringList.optional(), denyPaths: stringList.optional(), patterns: stringList.optional(),
    deleteOnDelete: z.boolean().optional(), purgeConclusionsOnDelete: z.boolean().optional(),
  }),
  "privacy.test": z.object({ text: z.string().max(200_000) }),
  "connection.get": empty,
  "connection.test": empty,
  "harness.state": machine,
  "harness.connect": machine,
  "harness.handOver": machine,
  "harness.undo": z.object({ machineId: text(200).optional(), step: z.enum(["connect", "handOver"]).optional() }),
  "backfill.dryRun": z.object({ projectId: text(200).optional(), since: z.string().max(100).optional() }),
  "backfill.start": z.object({ projectId: text(200).optional(), since: z.string().max(100).optional() }),
  "backfill.progress": empty,
  "backfill.stop": empty,
} satisfies Record<keyof RpcMethods, z.ZodType>;

/** Validates one method's input; failures become a clean refusal that never echoes the value. */
export function parseInput<K extends keyof RpcMethods>(name: K, input: unknown): RpcMethods[K][0] {
  const result = rpcInputs[name].safeParse(input);
  if (!result.success) {
    const where = result.error.issues[0]?.path.join(".");
    throw new experimental_PluginRpcRefusal({ code: "invalid", message: `Invalid input for ${name}${where ? `: ${where}` : ""}.` });
  }
  return result.data as RpcMethods[K][0];
}
type Entry<K extends keyof RpcMethods> = { input: StandardSchemaV1<RpcMethods[K][0], RpcMethods[K][0]>; output: StandardSchemaV1<RpcMethods[K][1], RpcMethods[K][1]> };
const method = <K extends keyof RpcMethods>(name: K): Entry<K> => ({ input: rpcInputs[name] as unknown as Entry<K>["input"], output: typed<RpcMethods[K][1]>() });

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
export const PROBE_TIMEOUT_MS = 3_000;
const keyHash = (key: string) => createHash("sha256").update(key).digest("hex");

export function registerRpc(bb: BbPluginApi, services: Services): () => void {
  const { capture, recall, harness, backfill, deps, secrets } = services;
  const kv = bb.storage.kv;
  const ok = { ok: true } as const;
  /** Tells open pages that durable state changed; they refetch over rpc. */
  const changed = (what: string) => { try { bb.realtime.publish("changed", { what }); } catch { /* best effort */ } };

  let probe: { at: number; id: string; level: ConnectionView["keyLevel"] } | null = null;
  /** Cache identity: the probe result is only valid for this exact url, key and workspace. */
  const probeId = (config: { baseUrl: string; apiKey: string; workspace: string }) => JSON.stringify([config.baseUrl, keyHash(config.apiKey), config.workspace]);
  async function runProbe(): Promise<ConnectionView["keyLevel"]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"unknown">((resolve) => { timer = setTimeout(() => resolve("unknown"), PROBE_TIMEOUT_MS); });
    try {
      return await Promise.race([(async () => (await deps.client()).probeKeyLevel())().catch(() => "unknown" as const), timeout]);
    } finally { clearTimeout(timer); }
  }
  async function keyLevel(config: { baseUrl: string; apiKey: string; workspace: string }, force = false): Promise<ConnectionView["keyLevel"]> {
    const id = probeId(config);
    if (!force && probe && probe.id === id && Date.now() - probe.at < PROBE_TTL_MS) return probe.level;
    const level = await runProbe();
    probe = { at: Date.now(), id, level };
    return level;
  }

  // The host validates too, but handlers must not trust their caller (tests and internal calls bypass it).
  const handlers = {
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
      if (!providerId.trim() || !/^[a-zA-Z0-9_-]{1,200}$/.test(name)) {
        throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Peer ids use letters, digits, - and _." });
      }
      // An agent peer named like the user would count agent messages as the user's and stop user modelling.
      if (name === (await deps.config()).config.peerName) {
        throw new experimental_PluginRpcRefusal({ code: "invalid", message: "That is the user peer; pick a different name." });
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
      return redact(text, { deny: [...keys, ...((await secrets?.()) ?? [])], patterns: compilePatterns(privacy.patterns) });
    },

    "connection.get": async (): Promise<ConnectionView> => {
      const { config, warnings } = await deps.config();
      return {
        preset: (await deps.isCloud()) ? "cloud" : "self-hosted",
        baseUrl: config.baseUrl,
        workspace: config.workspace,
        peerName: config.peerName,
        keySource: !config.apiKey ? "none" : warnings.some((w) => w.startsWith("bb apiKey")) ? "bb-secret" : "config-file",
        keyLevel: config.apiKey ? await keyLevel(config) : "unknown",
        warnings,
      };
    },
    "connection.test": async () => {
      const started = Date.now();
      try {
        const { config } = await deps.config();
        const level = await (await deps.client()).probeKeyLevel();
        probe = { at: Date.now(), id: probeId(config), level };
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
  } satisfies { [K in keyof RpcMethods]: (input: RpcMethods[K][0]) => RpcMethods[K][1] | Promise<RpcMethods[K][1]> };
  const validated = Object.fromEntries(Object.entries(handlers).map(([name, fn]) => [
    name, async (input: unknown) => (fn as (i: unknown) => unknown)(parseInput(name as keyof RpcMethods, input)),
  ])) as unknown as typeof handlers;
  bb.rpc.register(rpcContract, validated);

  // Realtime: one signal per activity entry; the UI refetches over rpc. Signals are ephemeral,
  // so the UI also polls slowly and refetches when the socket reconnects.
  const unsubscribe = deps.activity.subscribe((entry) => {
    try { bb.realtime.publish("activity", { id: entry.id, kind: entry.kind as ActivityKind, threadId: entry.threadId ?? null }); }
    catch { /* a failed signal must never break the writer */ }
  });
  bb.onDispose(unsubscribe);
  return unsubscribe;
}

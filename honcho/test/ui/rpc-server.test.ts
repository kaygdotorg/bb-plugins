import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ActivityEntry, Deps, RpcMethods } from "../../lib/contract";
import { PRIVACY_DEFAULTS, PROBE_TIMEOUT_MS, registerRpc, resolvePeer, type Services } from "../../lib/rpc-server";
import { HonchoError } from "../../lib/honcho-client";

function fakeBb() {
  const handlers: Record<string, (input: any) => any> = {};
  const kv = new Map<string, unknown>();
  const published: Array<[string, unknown]> = [];
  const disposers: Array<() => void> = [];
  const bb = {
    rpc: { register: (_contract: unknown, h: typeof handlers) => Object.assign(handlers, h) },
    storage: { kv: {
      get: async (k: string) => kv.get(k),
      set: async (k: string, v: unknown) => { kv.set(k, JSON.parse(JSON.stringify(v))); },
      delete: async (k: string) => { kv.delete(k); },
      list: async () => [...kv.keys()],
    } },
    realtime: { publish: (c: string, p: unknown) => published.push([c, p]) },
    onDispose: (fn: () => void) => disposers.push(fn),
  } as unknown as BbPluginApi;
  const call = <K extends keyof RpcMethods>(name: K, input: RpcMethods[K][0] = {} as never): Promise<RpcMethods[K][1]> => Promise.resolve(handlers[name]!(input));
  return { bb, call, published, disposers };
}

function fakeServices(overrides: { probe?: () => Promise<"workspace-or-admin" | "restricted"> ; apiKey?: string; warnings?: string[] } = {}) {
  const listeners: Array<(e: ActivityEntry) => void> = [];
  const calls: Array<[string, ...unknown[]]> = [];
  const spy = (name: string, result: unknown = undefined) => (...args: unknown[]) => { calls.push([name, ...args]); return Promise.resolve(result); };
  const state = { machineId: "m", claude: { hookInstalled: true, handedOver: false, pluginVersion: null }, codex: { hookInstalled: false, handedOver: false, trusted: null }, backups: [] };
  const cfg = { baseUrl: "https://honcho.example.org", apiKey: overrides.apiKey ?? "sk-test-key-0000", workspace: "w", peerName: "p" };
  const deps = {
    isCloud: async () => new URL(cfg.baseUrl).hostname === "api.honcho.dev",
    config: async () => ({ config: { ...cfg }, keys: ["sk-test-key-0000"], warnings: overrides.warnings ?? [] }),
    client: async () => ({ probeKeyLevel: overrides.probe ?? (async () => "workspace-or-admin" as const) }),
    activity: { list: (o: unknown) => { calls.push(["activity.list", o]); return []; }, record: () => {}, subscribe: (fn: (e: ActivityEntry) => void) => { listeners.push(fn); return () => listeners.splice(listeners.indexOf(fn), 1); } },
  } as unknown as Deps & { isCloud(): Promise<boolean> };
  const services: Services = {
    deps,
    capture: { threadStatus: spy("threadStatus", { threadId: "t", state: "saving", lastUploadAt: null, queued: 0, scope: null }), setPaused: spy("setPaused"), pauses: spy("pauses", []), health: spy("health", { oldestPendingAt: null, queued: 0, authFailing: false, tripwire: null }), flushNow: spy("flushNow") } as any,
    recall: { threadContext: spy("threadContext", { scope: null, top: [], fromThread: [], stale: false }), conclusions: spy("conclusions", []), deleteConclusion: spy("deleteConclusion"), confirmConclusion: spy("confirmConclusion") } as any,
    harness: { state: spy("harness.state", state), connect: spy("harness.connect", state), handOver: spy("harness.handOver", state), undo: spy("harness.undo", state) } as any,
    backfill: { dryRun: spy("dryRun", { threads: 1, messages: 2, tokens: 3, skippedAlreadyInHoncho: 0, reasoningMessages: 0 }), start: spy("start"), progress: spy("progress", { running: false, done: 0, total: 0 }), stop: spy("stop") } as any,
  };
  return { services, calls, listeners, cfg };
}

describe("rpc server", () => {
  it("delegates to the services", async () => {
    const { bb, call } = fakeBb();
    const { services, calls } = fakeServices();
    registerRpc(bb, services);
    await call("pause.set", { kind: "thread", id: "t1", paused: true });
    await call("conclusions.delete", { id: "c1" });
    await call("conclusions.confirm", { id: "c2" });
    await call("harness.connect", { machineId: "m" });
    await call("harness.handOver", {});
    await call("harness.undo", {});
    await call("backfill.start", {});
    await call("backfill.stop");
    await call("activity.list", { limit: 5 });
    expect(calls.map((c) => c[0])).toEqual(["setPaused", "deleteConclusion", "confirmConclusion", "harness.connect", "harness.handOver", "harness.undo", "start", "stop", "activity.list"]);
    expect(calls[0]).toEqual(["setPaused", { kind: "thread", id: "t1" }, true]);
  });

  it("stores peers with renames, defaults and firstSeen", async () => {
    const { bb, call } = fakeBb();
    registerRpc(bb, fakeServices().services);
    const before = await call("peers.list");
    expect(before.find((p) => p.providerId === "claude-code")).toEqual({ providerId: "claude-code", peer: "claude_code", firstSeen: null });
    await call("peers.rename", { providerId: "codex", peer: "codex_two" });
    const after = await call("peers.list");
    const codex = after.find((p) => p.providerId === "codex")!;
    expect(codex.peer).toBe("codex_two");
    expect(codex.firstSeen).toBeTypeOf("number");
    await expect(call("peers.rename", { providerId: "codex", peer: "bad peer!" })).rejects.toThrow();
    expect(await resolvePeer(bb.storage.kv, "codex")).toBe("codex_two");
    expect(await resolvePeer(bb.storage.kv, "pi")).toBe("pi");
  });

  it("keeps privacy defaults, merges patches and rejects bad regexes", async () => {
    const { bb, call } = fakeBb();
    registerRpc(bb, fakeServices().services);
    expect(await call("privacy.get")).toEqual(PRIVACY_DEFAULTS);
    const next = await call("privacy.set", { denyPaths: [" /work/client/** ", ""], deleteOnDelete: false });
    expect(next.denyPaths).toEqual(["/work/client/**"]);
    expect(next.deleteOnDelete).toBe(false);
    expect(next.purgeConclusionsOnDelete).toBe(true);
    await expect(call("privacy.set", { patterns: ["("] })).rejects.toThrow();
    expect((await call("privacy.get")).patterns).toEqual([]);
  });

  it("tests redaction with user patterns and the config keys", async () => {
    const { bb, call } = fakeBb();
    registerRpc(bb, fakeServices().services);
    await call("privacy.set", { patterns: ["ACME-\\d+"] });
    const result = await call("privacy.test", { text: "ticket ACME-42 with key sk-test-key-0000 ok" });
    expect(result.count).toBe(2);
    expect(result.text).not.toContain("ACME-42");
    expect(result.text).not.toContain("sk-test-key-0000");
  });

  it("builds the connection view without the key", async () => {
    const { bb, call } = fakeBb();
    registerRpc(bb, fakeServices({ warnings: ["bb apiKey overrides the Honcho file setting."] }).services);
    const view = await call("connection.get");
    expect(view).toMatchObject({ preset: "self-hosted", baseUrl: "https://honcho.example.org", workspace: "w", peerName: "p", keySource: "bb-secret", keyLevel: "workspace-or-admin" });
    expect(JSON.stringify(view)).not.toContain("sk-test-key");
  });

  it("reports no key, and a failing test", async () => {
    const a = fakeBb();
    registerRpc(a.bb, fakeServices({ apiKey: "" }).services);
    expect(await a.call("connection.get")).toMatchObject({ keySource: "none", keyLevel: "unknown" });
    const b = fakeBb();
    registerRpc(b.bb, fakeServices({ probe: async () => { throw new HonchoError("auth", 401); } }).services);
    expect(await b.call("connection.test")).toEqual({ ok: false, latencyMs: null, error: "key rejected" });
    const c = fakeBb();
    registerRpc(c.bb, fakeServices().services);
    const good = await c.call("connection.test");
    expect(good.ok).toBe(true);
  });

  it("signals a change after a mutation", async () => {
    const { bb, call, published } = fakeBb();
    registerRpc(bb, fakeServices().services);
    await call("pause.set", { kind: "project", id: "p", paused: true });
    expect(published).toEqual([["changed", { what: "pause" }]]);
  });

  it("publishes a realtime signal per activity entry and stops on dispose", () => {
    const { bb, published } = fakeBb();
    const { services, listeners } = fakeServices();
    const stop = registerRpc(bb, services);
    listeners[0]!({ id: 1, at: 1, kind: "upload", threadId: "t1", summary: "x" });
    expect(published).toEqual([["activity", { id: 1, kind: "upload", threadId: "t1" }]]);
    stop();
    expect(listeners).toHaveLength(0);
  });

  it("keys the probe cache by url, key and workspace", async () => {
    const { bb, call } = fakeBb();
    let level: "workspace-or-admin" | "restricted" = "workspace-or-admin";
    const probe = vi.fn(async () => level);
    const { services, cfg } = fakeServices({ probe });
    registerRpc(bb, services);
    expect((await call("connection.get")).keyLevel).toBe("workspace-or-admin");
    await call("connection.get"); expect(probe).toHaveBeenCalledTimes(1);
    level = "restricted";
    cfg.apiKey = "sk-rotated"; expect((await call("connection.get")).keyLevel).toBe("restricted");
    level = "workspace-or-admin";
    cfg.workspace = "w2"; expect((await call("connection.get")).keyLevel).toBe("workspace-or-admin");
    level = "restricted";
    cfg.baseUrl = "https://other.example.org"; expect((await call("connection.get")).keyLevel).toBe("restricted");
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it("gives the probe its own timeout and answers unknown", async () => {
    vi.useFakeTimers();
    try {
      const { bb, call } = fakeBb();
      const { services } = fakeServices({ probe: () => new Promise(() => {}) });
      registerRpc(bb, services);
      const pending = call("connection.get");
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
      expect((await pending).keyLevel).toBe("unknown");
    } finally { vi.useRealTimers(); }
  });

  it("takes the preset from deps.isCloud, not a hostname suffix", async () => {
    const { bb, call } = fakeBb();
    const { services, cfg } = fakeServices();
    registerRpc(bb, services);
    cfg.baseUrl = "https://evilhoncho.dev"; expect((await call("connection.get")).preset).toBe("self-hosted");
    cfg.baseUrl = "https://api.honcho.dev"; expect((await call("connection.get")).preset).toBe("cloud");
  });

  it("validates every input with clean errors", async () => {
    const { bb, call } = fakeBb();
    const { services, calls } = fakeServices();
    registerRpc(bb, services);
    await expect(call("pause.set", { kind: "machine", id: "x", paused: true } as never)).rejects.toThrow(/Invalid input for pause.set/);
    await expect(call("pause.set", { kind: "thread", id: "", paused: true })).rejects.toThrow(/Invalid input/);
    await expect(call("peers.rename", { providerId: "codex" } as never)).rejects.toThrow(/Invalid input for peers.rename/);
    await expect(call("peers.rename", undefined as never)).rejects.toThrow(/Invalid input/);
    await expect(call("privacy.test", { text: 5 } as never)).rejects.toThrow(/Invalid input for privacy.test/);
    await expect(call("privacy.set", { patterns: "x" } as never)).rejects.toThrow(/Invalid input/);
    await expect(call("conclusions.delete", {} as never)).rejects.toThrow(/Invalid input/);
    await expect(call("harness.undo", { step: "nope" } as never)).rejects.toThrow(/Invalid input/);
    expect(calls.filter(([n]) => n === "setPaused")).toEqual([]);
    // No-input methods still accept an omitted or empty payload.
    await expect(call("pause.list", undefined as never)).resolves.toEqual([]);
  });

  it("refuses to rename a provider to the user peer or an empty or invalid id", async () => {
    const { bb, call } = fakeBb();
    registerRpc(bb, fakeServices().services);
    await expect(call("peers.rename", { providerId: "codex", peer: "p" })).rejects.toThrow(/user peer/);
    await expect(call("peers.rename", { providerId: "codex", peer: "  " })).rejects.toThrow();
    await expect(call("peers.rename", { providerId: "codex", peer: "a b" })).rejects.toThrow();
    expect(await call("peers.list")).not.toContainEqual(expect.objectContaining({ peer: "p" }));
  });
});

describe("labels.get", () => {
  it("returns chat titles and project names, null for unknown or untitled", async () => {
    const { bb, call } = fakeBb();
    (bb as unknown as { sdk: unknown }).sdk = {
      threads: { get: async ({ threadId }: { threadId: string }) => { if (threadId === "gone") throw new Error("404"); return { title: threadId === "t1" ? " Fix login " : null }; } },
      projects: { get: async ({ projectId }: { projectId: string }) => ({ name: `name of ${projectId}` }) },
    };
    registerRpc(bb, fakeServices().services);
    expect(await call("labels.get", { threadIds: ["t1", "t2", "gone", "t1"], projectIds: ["p1"] })).toEqual({
      threads: { t1: "Fix login", t2: null, gone: null }, projects: { p1: "name of p1" },
    });
    expect(await call("labels.get", {})).toEqual({ threads: {}, projects: {} });
  });
});

import { afterEach, describe, expect, it } from "vitest";
import type { BbPluginApi, ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { RingActivityLog } from "../../lib/activity";
import { createHarnessService, registerHarnessHostOps, registerProviderEnv, harnessHostContract, harnessHostHandlers, type HarnessCaller } from "../../lib/harness";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { makeHome, snapshot, type FakeHome } from "./fixtures";

const homes: FakeHome[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });

function hostFor(h: FakeHome): { call: HarnessCaller; calls: string[] } {
  const handlers = harnessHostHandlers({ home: h.home, env: {} });
  const calls: string[] = [];
  const context = { experimental_paths: { dataDir: h.dataDir, tempDir: h.root } };
  const call: HarnessCaller = async (op, input, hostId) => {
    calls.push(`${op}@${hostId}`);
    // JSON round trip, like the wire.
    return JSON.parse(JSON.stringify(await (handlers[op] as (i: unknown, c: typeof context) => Promise<unknown>)(JSON.parse(JSON.stringify(input)), context)));
  };
  return { call, calls };
}

const fakeBb = (hosts: Array<{ id: string; status: string }>) => {
  const resolvers = new Map<string, (ctx: { threadId: string | null; projectId: string | null; hostId: string }) => unknown>();
  const bb = {
    providers: { experimental_contributeEnv: (id: string, fn: never) => { if (resolvers.has(id)) throw new Error("dup"); resolvers.set(id, fn); } },
    hosts: { experimental_client: () => { throw new Error("tests pass a caller"); } },
    sdk: { hosts: { list: async () => hosts.map((h) => ({ ...h, lifecycle: { phase: "active" } })) } },
  } as unknown as BbPluginApi;
  return { bb, resolvers };
};

describe("harness service", () => {
  it("runs every step through the host op on the chosen machine and records activity", async () => {
    const h = makeHome(); homes.push(h);
    const original = snapshot(h);
    const { call, calls } = hostFor(h);
    const activity = new RingActivityLog();
    const { bb } = fakeBb([{ id: "host_a", status: "connected" }]);
    const service = createHarnessService(bb, { activity, call });

    expect((await service.state()).machineId).toBe("host_a");
    const connected = await service.connect();
    expect(connected.claude.hookInstalled && connected.codex.hookInstalled && connected.codex.trusted).toBe(true);
    const handed = await service.handOver("host_a");
    expect(handed.claude.handedOver && handed.codex.handedOver).toBe(true);
    expect(handed.backups).toHaveLength(2);
    const undone = await service.undo(undefined, "handOver");
    expect(undone.claude.handedOver).toBe(false);
    expect(undone.codex.hookInstalled).toBe(true);
    await service.undo();
    expect(snapshot(h)).toEqual(original);
    expect(calls.every((c) => c.endsWith("@host_a"))).toBe(true);
    expect(activity.list({ kinds: ["harness"] }).map((e) => e.summary)).toHaveLength(4);
  });

  it("asks for a machine when several are connected, and records failures", async () => {
    const h = makeHome(); homes.push(h);
    const { bb } = fakeBb([{ id: "a", status: "connected" }, { id: "b", status: "connected" }]);
    const activity = new RingActivityLog();
    const failing: HarnessCaller = async () => { throw new Error("daemon offline"); };
    const service = createHarnessService(bb, { activity, call: failing });
    await expect(service.state()).rejects.toThrow("choose one");
    await expect(service.connect("a")).rejects.toThrow("daemon offline");
    expect(activity.list({ kinds: ["failure"] })[0]).toMatchObject({ error: "daemon offline" });
  });
});

describe("provider env", () => {
  it("contributes the gate and bb-owned paths per provider, and nothing secret", async () => {
    const h = makeHome(); homes.push(h);
    const { call, calls } = hostFor(h);
    const { bb, resolvers } = fakeBb([]);
    registerProviderEnv(bb, { call });
    expect([...resolvers.keys()].sort()).toEqual(["claude-code", "codex", "pi"]);
    const ctx = { threadId: "thr_1", projectId: "p", hostId: "host_a" };
    const env = async (id: string) => Object.fromEntries(((await resolvers.get(id)!(ctx)) as ExperimentalPluginProviderEnvEntry[]).map((e) => [e.name, e.value]));

    const claude = await env("claude-code");
    expect(claude).toMatchObject({ BB_HONCHO: "1", HONCHO_API_KEY: "", BB_HONCHO_HOOK_BUDGET_MS: "400" });
    expect(claude.HONCHO_CONFIG_PATH).toMatch(/claude-honcho-disabled\.json$/);
    expect(claude.BB_HONCHO_RECALL_DIR).toBe(`${h.dataDir}/recall`);
    const codex = await env("codex");
    expect(codex.HONCHO_CONFIG_DIR).toBe(`${h.dataDir}/harness/codex-honcho`);
    expect(await env("pi")).toEqual({ BB_HONCHO: "1" });
    expect(calls).toEqual(["harnessEnv@host_a"]); // cached per host
    for (const value of [...Object.values(claude), ...Object.values(codex)]) expect(String(value)).not.toMatch(/fake-token|hch-/);
  });

  it("contributes nothing for a harness when the host cannot answer", async () => {
    const { bb, resolvers } = fakeBb([]);
    const activity = new RingActivityLog();
    registerProviderEnv(bb, { activity, call: async () => { throw new Error("no daemon"); } });
    expect(await resolvers.get("claude-code")!({ threadId: null, projectId: null, hostId: "h" })).toEqual([]);
    expect(await resolvers.get("codex")!({ threadId: null, projectId: null, hostId: "h" })).toEqual([]);
    expect(activity.list({ kinds: ["failure"] })).toHaveLength(1);
  });
});

describe("host op registration", () => {
  it("merges into a host entry's contract and handlers, refusing duplicates", () => {
    const hostApi = { contract: {} as Record<string, never>, handlers: {} as Record<string, unknown> };
    registerHarnessHostOps(hostApi);
    expect(Object.keys(hostApi.contract).sort()).toEqual(Object.keys(harnessHostContract).sort());
    expect(Object.keys(hostApi.handlers).sort()).toEqual(Object.keys(harnessHostContract).sort());
    expect(() => registerHarnessHostOps(hostApi)).toThrow("already registered");
  });
});

describe("host entry", () => {
  it("passes the SDK's host-entry validation and JSON boundary", async () => {
    const h = makeHome(); homes.push(h);
    const contract: Record<string, never> = {};
    const handlers: Record<string, unknown> = {};
    registerHarnessHostOps({ contract, handlers }, { home: h.home, env: {} });
    const entry = experimental_defineHostEntry({ contract: harnessHostContract, handlers: handlers as never });
    const harness = experimental_createHostEntryHarness(entry, { experimental_paths: { dataDir: h.dataDir, tempDir: h.root } });
    const result = await harness.experimental_call("harnessConnect", {});
    expect(result.state.codex.trusted).toBe(true);
    const undone = await harness.experimental_call("harnessUndo", { step: "connect" });
    expect(undone.state.claude.hookInstalled).toBe(false);
    await expect(harness.experimental_call("harnessUndo", { step: "nope" } as never)).rejects.toThrow();
    await harness.experimental_dispose();
  });
});

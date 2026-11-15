import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeHostResponse, makeMessageDispatchHookContext, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { rpcContract } from "../lib/rpc-server";
import { HONCHO_TOOL_NAMES } from "../lib/tools/names";
import { hostContract } from "../host";
import { mockHoncho } from "./mock-honcho";

// Records each long-running service's stopper, so disposal can be checked
// without reaching into the factory's locals.
const stopped = vi.hoisted(() => [] as string[]);
vi.mock("../lib/capture/index.js", async (load) => {
  const m = await load<typeof import("../lib/capture/index.js")>();
  return { ...m, createCaptureService: (...args: Parameters<typeof m.createCaptureService>) => {
    const s = m.createCaptureService(...args);
    const stop = s.stop;
    return Object.assign(s, { stop: () => { stopped.push("capture"); stop(); } });
  } };
});
vi.mock("../lib/recall/index.js", async (load) => {
  const m = await load<typeof import("../lib/recall/index.js")>();
  return { ...m, createRecallService: (...args: Parameters<typeof m.createRecallService>) => {
    const s = m.createRecallService(...args);
    const stop = s.stop;
    return Object.assign(s, { stop: () => { stopped.push("recall"); stop(); } });
  } };
});
vi.mock("../lib/backfill/index.js", async (load) => {
  const m = await load<typeof import("../lib/backfill/index.js")>();
  return { ...m, createBackfillService: (...args: Parameters<typeof m.createBackfillService>) => {
    const s = m.createBackfillService(...args);
    const stop = s.stop;
    return Object.assign(s, { stop: async () => { stopped.push("backfill"); await stop(); } });
  } };
});

const { default: plugin } = await import("../server");

// A fake HOME, so createDeps reads a synthetic ~/.honcho/config.json that points at the mock.
let home: string;
let previousHome: string | undefined;
let mock: Awaited<ReturnType<typeof mockHoncho>>;
beforeAll(async () => {
  mock = await mockHoncho();
  home = mkdtempSync(join(tmpdir(), "honcho-server-"));
  mkdirSync(join(home, ".honcho"));
  writeFileSync(join(home, ".honcho", "config.json"), JSON.stringify({ baseUrl: mock.baseUrl, workspace: "test", peerName: "hermy" }));
  previousHome = process.env.HOME;
  process.env.HOME = home;
});
afterAll(async () => {
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  await mock.close();
});

const ENV_PATHS = { claudeConfigPath: "/data/claude/none.json", codexConfigDir: "/data/codex", recallDir: "/data/recall" };
const STATE = { claude: { hookInstalled: false, handedOver: false, pluginVersion: null }, codex: { hookInstalled: false, handedOver: false, trusted: null }, backups: [] };
const HOST_RESULTS: Record<string, unknown> = {
  harnessEnv: ENV_PATHS,
  harnessState: STATE,
  harnessUndo: { state: STATE, restored: [] },
  "recall.write": { counter: 1, path: "/data/recall/x.json" },
};

const open: Array<{ dispose(): Promise<void> }> = [];
let listCalls = 0;
afterEach(async () => { for (const h of open.splice(0)) await h.dispose(); stopped.length = 0; listCalls = 0; });

async function load(settings: Record<string, string | number | boolean> = {}) {
  const fake = createFakePluginHost({
    pluginId: "honcho",
    settings,
    sdk: {
      threads: { list: async () => { listCalls++; return []; } },
      hosts: { list: async () => [makeHostResponse({ id: "host_a" })] },
    },
    experimental_callHostRpc: ({ method }) => {
      if (!(method in HOST_RESULTS)) throw new Error(`unexpected host call ${method}`);
      return HOST_RESULTS[method];
    },
  });
  await plugin(fake.bb);
  open.push(fake.harness.lifecycle);
  return fake.harness;
}

describe("plugin factory", () => {
  it("registers every surface exactly once", async () => {
    const h = await load();
    const r = h.inspection.registrations;
    expect(Object.keys(r.settingsDescriptors).sort()).toEqual([
      "apiKey", "backfillMessagesPerMinute", "baseUrl", "captureRequiresSwitchover", "codexUseBbTools", "hookBudgetMs", "peerName", "preset", "workspace",
    ]);
    expect(r.agentTools.map(t => t.name).sort()).toEqual([...HONCHO_TOOL_NAMES].sort());
    expect(r.rpcMethods.sort()).toEqual(Object.keys(rpcContract).sort());
    expect(r.cli?.name).toBe("honcho");
    expect((r.cli?.commands ?? []).map(c => c.usage.split(" [")[0]).sort()).toEqual([
      "bb honcho backfill", "bb honcho harness connect", "bb honcho harness hand-over", "bb honcho harness state", "bb honcho harness undo", "bb honcho pause", "bb honcho status",
    ]);
    expect(r.agentConfigurationProvider).not.toBeNull();
    expect(r.instructionProvider).toBeNull();
    expect(r.hooks["message.dispatch"]).not.toBeNull();
    expect([...r.providerEnvResolvers.keys()].sort()).toEqual(["claude-code", "codex", "pi"]);
    expect(r.services.map(x => x.name).sort()).toEqual(["capture-reconcile", "recall-refresh"]);
    expect(r.schedules).toEqual([]);
    expect(r.threadEventHandlers).toMatchObject({ "thread.created": 1, "thread.idle": 1, "thread.archived": 1, "thread.deleted": 1 });
    expect(r.threadEventHandlers["thread.active"]).toBe(2); // capture schedules, recall refreshes
  });

  it("merges every slice's host ops into one contract", () => {
    expect(Object.keys(hostContract).sort()).toEqual(["harnessConnect", "harnessEnv", "harnessHandOver", "harnessState", "harnessUndo", "recall.write"]);
  });

  it("serves the hook env from the one resolver per provider, with the shared hook budget", async () => {
    const h = await load({ hookBudgetMs: 650 });
    const ctx = { threadId: "thr_1", projectId: "p", hostId: "host_a" };
    const env = async (provider: string) => Object.fromEntries((await h.behavior.resolveProviderEnv(provider, ctx)).map(e => [e.name, e.value]));
    // The factory loaded the settings before registering: no wait for the first read.
    expect(await env("claude-code")).toEqual({
      BB_HONCHO: "1", BB_HONCHO_RECALL_DIR: "/data/recall", BB_HONCHO_HOOK_BUDGET_MS: "650",
      HONCHO_CONFIG_PATH: "/data/claude/none.json", HONCHO_API_KEY: "",
    });
    expect(await env("codex")).toEqual({ BB_HONCHO: "1", BB_HONCHO_RECALL_DIR: "/data/recall", BB_HONCHO_HOOK_BUDGET_MS: "650", HONCHO_CONFIG_DIR: "/data/codex" });
    expect(await env("pi")).toEqual({ BB_HONCHO: "1" });
    await h.behavior.setSettings({ hookBudgetMs: 900 });
    expect((await env("codex")).BB_HONCHO_HOOK_BUDGET_MS).toBe("900");
  });

  it("routes rpc, cli and the dispatch hook through the wired services", async () => {
    const h = await load();
    expect(await h.behavior.callRpc("harness.undo", { step: "connect" })).toMatchObject({ machineId: "host_a" });
    expect(h.inspection.experimental_hostRpcCalls.filter(c => c.method === "harnessUndo").map(c => c.input)).toEqual([{ step: "connect" }]);
    await expect(h.behavior.callRpc("harness.undo", { step: "everything" })).rejects.toThrow(/connect or handOver/);
    expect(await h.behavior.callRpc("privacy.get", {})).toMatchObject({ deleteOnDelete: true });
    const status = await h.behavior.runCli(["harness", "state"]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("machine host_a");
    const decision = await h.inspection.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ initiator: "user" }));
    expect(decision).toEqual({ action: "proceed" });
    const config = await h.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: "claude-code" } }));
    expect(config.tools.map(t => t.name).sort()).toEqual([...HONCHO_TOOL_NAMES].sort());
    const codex = await h.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: "codex" } }));
    expect(codex.tools).toEqual([]);
    // A stored opt-in applies from the first configure after load.
    const optedIn = await load({ codexUseBbTools: true });
    const codexOn = await optedIn.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ provider: { id: "codex" } }));
    expect(codexOn.tools.map(t => t.name).sort()).toEqual([...HONCHO_TOOL_NAMES].sort());
    expect(h.inspection.logEntries.filter(e => e.level === "warn" || e.level === "error")).toEqual([]);
  });

  it("stops every service on disposal, backfill first and capture last", async () => {
    const h = await load();
    expect(stopped).toEqual([]);
    await h.lifecycle.dispose();
    expect(stopped).toEqual(["backfill", "recall", "capture"]);
  });

  it("runs the startup catch-up and the recall refresh as services that end when aborted", async () => {
    const h = await load();
    // Nothing reads the thread list until the catch-up service runs.
    expect(listCalls).toBe(0);
    const capture = h.behavior.runService("capture-reconcile");
    const recall = h.behavior.runService("recall-refresh");
    await vi.waitFor(() => expect(listCalls).toBe(1));
    capture.controller.abort(); recall.controller.abort();
    await capture.done; await recall.done;
    expect(stopped).toEqual([]); // an abort ends the run; dispose stops the slices
  });
});

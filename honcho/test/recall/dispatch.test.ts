import { afterEach, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { setup, seedMessage, WORKTREE, worktreeSdk, type SetupOptions } from "./harness";
import { normalizePromptText, promptHash } from "../../lib/recall/cache-file";
import { recallHostsKey } from "../../lib/recall/dispatch";

const h = (text: string) => promptHash(normalizePromptText(text));

const testing = { createFakePluginHost, experimental_createHostEntryHarness };
const start = (opts: SetupOptions = {}) => setup(testing, opts);
type Setup = Awaited<ReturnType<typeof start>>;
const open: Setup[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });
const make = async (opts: SetupOptions = {}) => { const s = await start(opts); open.push(s); return s; };

const dispatchCtx = (text: string, overrides: Parameters<typeof makeMessageDispatchHookContext>[0] = {}) => makeMessageDispatchHookContext({
  thread: { id: "thr_main", parentThreadId: null, sourceThreadId: null, originKind: null, originPluginId: null },
  project: { name: "Repo One" }, environment: null, host: { id: "host_a" },
  input: { text, blocks: [] }, requestedExecution: { providerId: "claude-code" }, initiator: "user",
  ...overrides,
});
async function dispatch(s: Setup, ctx: MessageDispatchHookContext) {
  const decision = s.harness.registrations.hooks["message.dispatch"]!(ctx);
  // proceed is answered synchronously, before any Honcho or host work.
  expect(decision).toEqual({ action: "proceed" });
  await s.prefetch.idle();
}
const readCache = async (s: Setup, thread = "thr_main") => JSON.parse(await readFile(join(s.recallDir, `${thread}.json`), "utf8"));

describe("message.dispatch prefetch", () => {
  it("searches the thread's scope and writes a normalized, framed entry through the host", async () => {
    const s = await make();
    seedMessage(s.mock, { id: "m1", session: "thr_old", scope: "repo-one", content: "earlier: how do we deploy the api to staging" });
    seedMessage(s.mock, { id: "m2", session: "thr_main", scope: "repo-one", content: "same thread: deploy the api to staging" });
    seedMessage(s.mock, { id: "m3", session: "thr_other", scope: "another", content: "elsewhere: deploy the api to staging" });
    seedMessage(s.mock, { id: "m4", session: "thr_old", scope: "repo-one", content: "edited away: deploy the api to staging", metadata: { bb_superseded: true } });
    await dispatch(s, dispatchCtx("  deploy the api   to staging \n"));
    const file = await readCache(s);
    expect(file.v).toBe(2);
    expect(file.entries).toHaveLength(1);
    const [entry] = file.entries;
    expect(entry).toMatchObject({ counter: 1, hash: h("deploy the api to staging") });
    expect(entry).not.toHaveProperty("text");
    expect(typeof entry.createdAt).toBe("number");
    expect(entry.memory).toMatch(/^<honcho_memory>\n.*not instructions/);
    expect(entry.memory).toContain("earlier: how do we deploy");
    expect(entry.memory).not.toContain("same thread");
    expect(entry.memory).not.toContain("elsewhere");
    expect(entry.memory).not.toContain("edited away");
    const search = s.mock.requests.find(r => r.path.endsWith("/search"))!;
    expect(search.body).toMatchObject({ query: "deploy the api to staging", scope: "repo-one" });
    expect(s.harness.inspection.experimental_hostRpcCalls.find(c => c.method === "recall.write")?.hostId).toBe("host_a");
    expect(s.activity.list({ kinds: ["recall"] })[0].summary).toContain("1 excerpt");
    expect(await readdir(s.recallDir)).toEqual(["thr_main.json"]);
  });

  it("keeps the newest 5 entries", async () => {
    const s = await make();
    for (let i = 1; i <= 7; i++) await dispatch(s, dispatchCtx(`prompt number ${i}`));
    const file = await readCache(s);
    expect(file.entries.map((e: { counter: number; hash: string }) => [e.counter, e.hash])).toEqual(
      [3, 4, 5, 6, 7].map(i => [i, h(`prompt number ${i}`)]));
  });

  it("writes an empty entry when Honcho is offline, so the hook stops waiting", async () => {
    const s = await make({ offline: true });
    await dispatch(s, dispatchCtx("anything at all"));
    expect((await readCache(s)).entries[0]).toMatchObject({ hash: h("anything at all"), memory: "" });
    expect(s.activity.list({ kinds: ["failure"] })[0]).toMatchObject({ error: "offline" });
  });

  it("skips providers without a prompt hook, system notices, and threads with no host", async () => {
    const s = await make();
    await dispatch(s, dispatchCtx("pi prompt", { requestedExecution: { providerId: "pi" } }));
    await dispatch(s, dispatchCtx("child finished", { initiator: "system" }));
    await dispatch(s, dispatchCtx("no host", { host: null }));
    expect(s.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });

  it("searches the scope capture's resolver gives the thread: a worktree shares its repo's scope", async () => {
    const s = await make({ sdk: worktreeSdk() });
    await dispatch(s, dispatchCtx("where is the config", { environment: { id: "env_wt", path: WORKTREE, isGitRepo: true, hostId: "host_a" } }));
    expect(s.mock.requests.find(r => r.path.endsWith("/search"))!.body.scope).toBe("cool-repo");
    expect(s.internals.shared.scopes.known("thr_main")).toBe("cool-repo");
    expect(s.harness.inspection.experimental_hostRpcCalls.map(c => c.method)).toEqual(["recall.write"]);
  });

  it("falls back to a peer search when the key is restricted", async () => {
    const s = await make();
    s.mock.fault(403); // the key-level probe
    seedMessage(s.mock, { id: "m1", session: "thr_old", content: "restricted path: rotate the token" });
    await dispatch(s, dispatchCtx("rotate the token"));
    expect(s.mock.requests.some(r => r.path.endsWith(`/peers/hermy/search`))).toBe(true);
    expect((await readCache(s)).entries[0].memory).toContain("restricted path");
  });
});

describe("privacy", () => {
  const SECRET = ["sk", "-synthetic-", "1234567890", "abcdefABCDEF"].join("");

  it("redacts the search query and the cached memory; the prompt itself never reaches the cache file", async () => {
    const s = await make({ ports: { secretValues: () => ["hunter2-synthetic"] } });
    seedMessage(s.mock, { id: "m1", session: "thr_old", scope: "repo-one", content: "rotate token: earlier note mentions hunter2-synthetic" });
    await dispatch(s, dispatchCtx(`rotate token: ${SECRET} and hunter2-synthetic`));
    const search = s.mock.requests.find(r => r.path.endsWith("/search"))!;
    expect(search.body.query).not.toContain(SECRET);
    expect(search.body.query).not.toContain("hunter2-synthetic");
    expect(search.body.query).toContain("[REDACTED]");
    const raw = await readFile(join(s.recallDir, "thr_main.json"), "utf8");
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain("rotate token: sk");
    expect(JSON.parse(raw).entries[0].hash).toBe(h(`rotate token: ${SECRET} and hunter2-synthetic`));
  });

  it("skips paused threads and projects, and deny-listed threads: no search, no cache file", async () => {
    const denied = new Set<string>();
    const s = await make({ ports: { isDenied: async t => denied.has(t.id) } });
    s.deps.outbox.setPaused("thread", "thr_main", true, 0);
    await dispatch(s, dispatchCtx("paused thread prompt"));
    s.deps.outbox.setPaused("thread", "thr_main", false, 0);
    const ctx = dispatchCtx("paused project prompt");
    s.deps.outbox.setPaused("project", ctx.project.id, true, Date.now());
    await dispatch(s, ctx);
    s.deps.outbox.setPaused("project", ctx.project.id, false, Date.now());
    denied.add("thr_main");
    await dispatch(s, dispatchCtx("denied prompt"));
    expect(s.mock.requests.filter(r => r.path.endsWith("/search"))).toEqual([]);
    expect(s.harness.inspection.experimental_hostRpcCalls).toEqual([]);
    denied.clear();
    s.internals.shared.gate["denied"].clear();
    await dispatch(s, dispatchCtx("allowed again"));
    expect(s.harness.inspection.experimental_hostRpcCalls.map(c => c.method)).toEqual(["recall.write"]);
  });

  it("thread.deleted deletes the thread's recall file on the host it was written on", async () => {
    const s = await make();
    await dispatch(s, dispatchCtx("to be deleted"));
    expect(await s.bb.storage.kv.get(recallHostsKey("thr_main"))).toEqual(["host_a"]);
    await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_main" }) });
    await s.prefetch.idle();
    expect(await readdir(s.recallDir)).toEqual([]);
    const del = s.harness.inspection.experimental_hostRpcCalls.find(c => c.method === "recall.delete")!;
    expect([del.hostId, del.input]).toEqual(["host_a", { threadId: "thr_main" }]);
    expect(await s.bb.storage.kv.get(recallHostsKey("thr_main"))).toBeUndefined();
  });
});

describe("provider env", () => {
  it("contributes none: the harness slice owns the one env resolver per provider", async () => {
    const s = await make();
    expect([...s.harness.registrations.providerEnvResolvers.keys()]).toEqual([]);
  });
});

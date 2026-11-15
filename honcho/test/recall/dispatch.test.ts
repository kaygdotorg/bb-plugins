import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { setup, seedMessage, type SetupOptions } from "./harness";

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
    expect(file.v).toBe(1);
    expect(file.entries).toHaveLength(1);
    const [entry] = file.entries;
    expect(entry).toMatchObject({ counter: 1, text: "deploy the api to staging" });
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
    expect(file.entries.map((e: { counter: number; text: string }) => [e.counter, e.text])).toEqual(
      [3, 4, 5, 6, 7].map(i => [i, `prompt number ${i}`]));
  });

  it("writes an empty entry when Honcho is offline, so the hook stops waiting", async () => {
    const s = await make({ offline: true });
    await dispatch(s, dispatchCtx("anything at all"));
    expect((await readCache(s)).entries[0]).toMatchObject({ text: "anything at all", memory: "" });
    expect(s.activity.list({ kinds: ["failure"] })[0]).toMatchObject({ error: "offline" });
  });

  it("skips providers without a prompt hook, system notices, and threads with no host", async () => {
    const s = await make();
    await dispatch(s, dispatchCtx("pi prompt", { requestedExecution: { providerId: "pi" } }));
    await dispatch(s, dispatchCtx("child finished", { initiator: "system" }));
    await dispatch(s, dispatchCtx("no host", { host: null }));
    expect(s.harness.inspection.experimental_hostRpcCalls).toEqual([]);
  });

  it("computes the git scope on the thread's host, like the session scope", async () => {
    const s = await make();
    const repo = join(s.dataDir, "work", "Cool.Repo");
    await mkdir(repo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: repo });
    await dispatch(s, dispatchCtx("where is the config", { environment: { path: repo, isGitRepo: true, hostId: "host_a" } }));
    expect(s.mock.requests.find(r => r.path.endsWith("/search"))!.body.scope).toBe("cool-repo");
    expect(s.internals.shared.scopes.known("thr_main")).toBe("cool-repo");
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

describe("provider env", () => {
  it("contributes the recall dir and hook budget for claude-code and codex only", async () => {
    const s = await make({ settings: { hookBudgetMs: 650 } });
    const env = await s.harness.behavior.resolveProviderEnv("claude-code", { threadId: "thr_main", projectId: "p", hostId: "host_a" });
    expect(Object.fromEntries(env.map(e => [e.name, e.value]))).toEqual({ BB_HONCHO_RECALL_DIR: s.recallDir, BB_HONCHO_HOOK_BUDGET_MS: "650" });
    expect([...s.harness.registrations.providerEnvResolvers.keys()].sort()).toEqual(["claude-code", "codex"]);
  });
  it("omits the dir when the host cannot be reached", async () => {
    const s = await make();
    const original = s.host.experimental_call;
    s.host.experimental_call = (async () => { throw new Error("daemon offline"); }) as typeof original;
    const env = await s.harness.behavior.resolveProviderEnv("codex", { threadId: null, projectId: null, hostId: "host_b" });
    expect(env.map(e => e.name)).toEqual(["BB_HONCHO_HOOK_BUDGET_MS"]);
    expect(env[0].value).toBe("400");
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { setup, seedConclusion, type SetupOptions } from "./harness";

const testing = { createFakePluginHost, experimental_createHostEntryHarness };
const start = (opts: SetupOptions = {}) => setup(testing, opts);
type Setup = Awaited<ReturnType<typeof start>>;
const open: Setup[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });
const make = async (opts: SetupOptions = {}) => { const s = await start(opts); open.push(s); return s; };

describe("RecallService", () => {
  it("threadContext returns scope, top scope conclusions and the thread's own, with agent-written marks", async () => {
    const s = await make();
    s.internals.shared.scopes.remember("thr_main", "repo-one");
    seedConclusion(s.mock, { id: "con_scope", content: "repo-one uses pnpm" });
    await s.harness.behavior.callAgentTool("honcho_conclude", { content: "prefers zsh" }, { threadId: "thr_main" });
    const ctx = await s.recall.threadContext("thr_main");
    expect(ctx.scope).toBe("repo-one");
    expect(ctx.stale).toBe(false);
    expect(ctx.top.map(c => [c.id, c.agentWritten])).toEqual([["con_scope", false]]);
    expect(ctx.fromThread).toHaveLength(1);
    expect(ctx.fromThread[0]).toMatchObject({ content: "prefers zsh", agentWritten: true, confirmed: false });
  });

  it("threadContext serves the cache marked stale when Honcho is offline", async () => {
    const s = await make();
    s.internals.shared.scopes.remember("thr_main", "repo-one");
    seedConclusion(s.mock, { id: "con_scope", content: "repo-one uses pnpm" });
    await s.recall.threadContext("thr_main");
    s.state.offline = true;
    const ctx = await s.recall.threadContext("thr_main");
    expect(ctx.stale).toBe(true);
    expect(ctx.top.map(c => c.id)).toEqual(["con_scope"]);
  });

  it("conclusions lists newest first or queries; confirm and delete update the marks", async () => {
    const s = await make();
    seedConclusion(s.mock, { id: "con_a", content: "alpha fact", level: "explicit" });
    seedConclusion(s.mock, { id: "con_b", content: "beta fact" });
    expect((await s.recall.conclusions({})).map(c => c.id)).toEqual(["con_b", "con_a"]);
    expect((await s.recall.conclusions({ query: "alpha" })).map(c => c.id)).toEqual(["con_a"]);
    // An explicit conclusion with no local mark was derived from the user's own messages: learned, not agent-written.
    expect((await s.recall.conclusions({ query: "alpha" }))[0]).toMatchObject({ origin: "learned", agentWritten: false, confirmed: false });
    await s.recall.confirmConclusion("con_a");
    expect((await s.recall.conclusions({ query: "alpha" }))[0]).toMatchObject({ origin: "confirmed", confirmed: true });
    await s.recall.deleteConclusion("con_b");
    expect(s.mock.conclusions.map(c => c.id)).toEqual(["con_a"]);
    expect(s.activity.list({ kinds: ["delete"] })).toHaveLength(1);
    const query = s.mock.requests.find(r => r.path.endsWith("/conclusions/query"))!;
    expect(query.body.filters).toEqual({ observer_id: "hermy", observed_id: "hermy" });
  });

  it("search puts exact word matches first, case-insensitively, and asks for a distance cut", async () => {
    const s = await make();
    seedConclusion(s.mock, { id: "con_1", content: "unrelated health fact" });
    seedConclusion(s.mock, { id: "con_2", content: "Works with a TESTER named Rita" });
    seedConclusion(s.mock, { id: "con_3", content: "rita likes tea" });
    const got = await s.recall.conclusions({ query: "tester rita", limit: 50 });
    expect(got.map(c => c.id).sort()).toEqual(["con_2", "con_3"]);
    expect(got.every(c => /rita|tester/i.test(c.content))).toBe(true);
    const query = s.mock.requests.find(r => r.path.endsWith("/conclusions/query"))!;
    expect(query.body.distance).toBeGreaterThan(0);
    expect(query.body.distance).toBeLessThanOrEqual(0.6);
  });

  it("search skips the semantic lookup when there are ten exact matches", async () => {
    const s = await make();
    for (let n = 0; n < 12; n++) seedConclusion(s.mock, { id: `con_${n}`, content: `Rita fact ${n}` });
    const got = await s.recall.conclusions({ query: "rita", limit: 50 });
    expect(got).toHaveLength(12);
    expect(s.mock.requests.some(r => r.path.endsWith("/conclusions/query"))).toBe(false);
  });

  it("start() refreshes now, then every 5 minutes, and stops cleanly", async () => {
    const s = await make({ ports: { peerCard: async () => ["Name: Sam"] } });
    const stop = s.recall.start();
    await s.internals.cache.refresh();
    expect(s.internals.cache.snapshot().card).toEqual(["Name: Sam"]);
    stop();
    stop();
  });
});

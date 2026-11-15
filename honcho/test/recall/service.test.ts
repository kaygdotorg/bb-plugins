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
    // An explicit conclusion with no local mark came from an agent (e.g. the claude-honcho CLI).
    expect((await s.recall.conclusions({ query: "alpha" }))[0]).toMatchObject({ agentWritten: true, confirmed: false });
    await s.recall.confirmConclusion("con_a");
    expect((await s.recall.conclusions({ query: "alpha" }))[0]).toMatchObject({ confirmed: true });
    await s.recall.deleteConclusion("con_b");
    expect(s.mock.conclusions.map(c => c.id)).toEqual(["con_a"]);
    expect(s.activity.list({ kinds: ["delete"] })).toHaveLength(1);
    const query = s.mock.requests.find(r => r.path.endsWith("/conclusions/query"))!;
    expect(query.body.filters).toEqual({ observer_id: "hermy", observed_id: "hermy" });
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

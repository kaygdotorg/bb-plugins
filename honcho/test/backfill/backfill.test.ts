import { afterEach, describe, expect, it, vi } from "vitest";
import { claudeSessionName, codexChatInstanceName, codexPerDirectoryName, TimeIndex } from "../../lib/backfill";
import { RateLimiter } from "../../lib/backfill/rate";
import type { HonchoPort } from "../../lib/backfill";
import { createBackfillService } from "../../lib/backfill";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { setup as baseSetup, T0, turn, type FakeThread } from "./harness";
const setup = (...args: [FakeThread[], Parameters<typeof baseSetup>[2]?]) => baseSetup(createFakePluginHost, ...args);

type Env = Awaited<ReturnType<typeof baseSetup>>;
let env: Env | undefined;
afterEach(async () => { vi.useRealTimers(); await env?.close(); env = undefined; });
const seed = (e: Env, session: string, rows: Array<{ content: string; at: number; peer?: string }>) => {
  for (const [i, r] of rows.entries()) e.mock.messages.push({ id: `seed_${session}_${i}`, workspace_id: "test", session_id: session, peer_id: r.peer ?? "hermy", content: r.content, created_at: new Date(r.at).toISOString(), metadata: {} });
};
const thread = (over: Partial<FakeThread> & { id: string }, turns = 1): FakeThread => ({
  providerId: "codex", cwd: "/work/My Repo", events: Array.from({ length: turns }, (_, n) => turn(over.id, n, `question ${n} of ${over.id}`)).flat(), ...over,
});

describe("session naming (copied from the harness plugins)", () => {
  it("claude: sanitizes the session id like claude-honcho", () => {
    expect(claudeSessionName("AbC-123_x.y/z")).toBe("abc-123_x-y-z");
    expect(claudeSessionName("")).toBeNull();
  });
  it("codex: chat-instance and per-directory names", () => {
    expect(codexPerDirectoryName("/work/My Repo")).toBe("my-repo");
    expect(codexChatInstanceName("/work/My Repo", "019AbC.def-ghi")).toBe("my-repo-019abc-d");
  });
  it("time index matches within 120 seconds, normalizing whitespace", () => {
    const index = new TimeIndex(); index.add("hello   world\n", 1_000_000);
    expect(index.has(" hello world ", 1_000_000 + 120_000)).toBe(true);
    expect(index.has("hello world", 1_000_000 + 121_000)).toBe(false);
    expect(index.has("other", 1_000_000)).toBe(false);
  });
});

describe("dedupe", () => {
  it("claude: a thread whose sanitized provider session id exists in honcho is skipped", async () => {
    env = await setup([
      thread({ id: "thr_c1", providerId: "claude-code", providerThreadIds: ["Sess.ABC-1"] }, 2),
      thread({ id: "thr_c2", providerId: "claude-code", providerThreadIds: ["Other-2"] }, 1),
    ]);
    seed(env, "sess-abc-1", [{ content: "anything", at: T0 }]);
    expect(await env.service.dryRun()).toEqual({ threads: 1, messages: 2, tokens: expect.any(Number), skippedAlreadyInHoncho: 4, reasoningMessages: 1 });
  });
  it("codex chat-instance: matched by folder-<first 8 of the chat id>", async () => {
    env = await setup([
      thread({ id: "thr_x1", providerThreadIds: ["019AbCdE-1111"] }, 1),
      thread({ id: "thr_x2", providerThreadIds: ["019ffff0-2222"] }, 1),
    ]);
    seed(env, "my-repo-019abcde", [{ content: "x", at: T0 }]);
    const plan = await env.service.dryRun();
    expect(plan).toMatchObject({ threads: 1, messages: 2, skippedAlreadyInHoncho: 2 });
  });
  it("codex per-directory: skips messages with the same text within 120s, keeps the rest", async () => {
    env = await setup([thread({ id: "thr_d", providerThreadIds: ["019aaaaa-0"] }, 3)]);
    const at = (n: number) => T0 + n * 60_000;
    seed(env, "my-repo", [
      { content: "question 0 of  thr_d", at: at(0) + 90_000 },          // within 120 s, whitespace differs: match
      { content: "reply to question 1 of thr_d", at: at(1) + 130_000, peer: "codex" }, // outside window: no match
      { content: "question 2 of thr_d", at: at(2) + 5_000 },           // match
    ]);
    const plan = await env.service.dryRun();
    expect(plan.skippedAlreadyInHoncho).toBe(2);
    expect(plan.messages).toBe(4);
  });
  it("skips anything the plugin already uploaded, by bb_thread/bb_seq", async () => {
    env = await setup([thread({ id: "thr_o" }, 2)]);
    await env.service.start(); await env.service.whenIdle();
    const first = env.mock.messages.length;
    expect(first).toBe(4);
    expect(await env.service.dryRun()).toMatchObject({ messages: 0 });
    await env.service.start(); await env.service.whenIdle();
    expect(env.mock.messages).toHaveLength(first);
  });
  it("redacts like capture before comparing, so a redacted upload still matches", async () => {
    const events = turn("thr_r", 0, "my key is synthetic-key ok");
    env = await setup([{ id: "thr_r", providerId: "codex", cwd: "/work/My Repo", events }]);
    seed(env, "my-repo", [{ content: "my key is synthetic-key ok", at: T0 }]);
    expect((await env.service.dryRun()).skippedAlreadyInHoncho).toBe(1);
  });
});

describe("plan and upload", () => {
  it("transforms with original timestamps, reasoning only on hermy, and session peers and scope", async () => {
    env = await setup([thread({ id: "thr_t" }, 1)]);
    await env.service.start(); await env.service.whenIdle();
    const [user, agentMessage] = env.mock.messages;
    expect(user).toMatchObject({ peer_id: "hermy", created_at: new Date(T0).toISOString(), configuration: { reasoning: { enabled: true } }, metadata: { bb_thread: "thr_t" } });
    expect(agentMessage).toMatchObject({ peer_id: "codex", configuration: { reasoning: { enabled: false } } });
    const session = env.mock.requests.find(r => r.method === "POST" && r.path === "/v3/workspaces/test/sessions")!;
    expect(session.body).toMatchObject({ id: "thr_t", scopes: ["proj_a"], peers: { hermy: { observe_me: true }, codex: { observe_me: false } } });
    expect(env.activity.some(a => a.kind === "backfill" && a.threadId === "thr_t")).toBe(true);
  });
  it("skips archived threads by default and includes them when asked", async () => {
    env = await setup([thread({ id: "thr_live" }), thread({ id: "thr_old", archived: true })]);
    expect((await env.service.dryRun()).threads).toBe(1);
    expect((await env.service.dryRun({ includeArchived: true })).threads).toBe(2);
  });
  it("filters by project and by --since", async () => {
    env = await setup([thread({ id: "thr_p1", projectId: "proj_a" }), thread({ id: "thr_p2", projectId: "proj_b", events: turn("thr_p2", 0, "late", T0 + 10 * 86_400_000) })]);
    expect((await env.service.dryRun({ projectId: "proj_b" })).threads).toBe(1);
    expect(await env.service.dryRun({ since: new Date(T0 + 5 * 86_400_000).toISOString() })).toMatchObject({ threads: 1, messages: 1 + 1 - 0 });
  });
  it("skips paused threads and the privacy deny list", async () => {
    env = await setup([thread({ id: "thr_pa" }), thread({ id: "thr_dn" }), thread({ id: "thr_ok" })], { isDenied: t => t.id === "thr_dn" });
    env.outbox.setPaused("thread", "thr_pa", true, 0);
    expect((await env.service.dryRun()).threads).toBe(1);
  });
  it("estimates tokens as chars/4", async () => {
    env = await setup([{ id: "thr_k", providerId: "codex", cwd: "/w", events: turn("thr_k", 0, "a".repeat(40), T0, "b".repeat(40)) }]);
    expect(await env.service.dryRun()).toMatchObject({ messages: 2, tokens: 20 });
  });
});

describe("switch-over marker", () => {
  it("reads events only before the marker", async () => {
    env = await setup([thread({ id: "thr_m" }, 4)]); // seqs 1..12
    env.outbox.markSwitchOver("thr_m", 7);
    await env.service.start(); await env.service.whenIdle();
    const seqs = env.mock.messages.map(m => m.metadata.bb_seq as number);
    expect(seqs.length).toBe(4); // turns 0 and 1 (seq 1,3 and 4,6)
    expect(Math.max(...seqs)).toBeLessThan(7);
    await env.service.start(); await env.service.whenIdle();
    expect(env.mock.messages).toHaveLength(4);
  });
});

describe("dry run", () => {
  it("writes nothing to honcho or to the cursor store", async () => {
    env = await setup([thread({ id: "thr_w" }, 3)]);
    const plan = await env.service.dryRun();
    expect(plan.messages).toBe(6);
    expect(env.mock.messages).toHaveLength(0);
    expect(env.mock.requests.every(r => /\/(messages\/list|search)$/.test(r.path))).toBe(true);
    expect(env.db.prepare("SELECT count(*) AS n FROM backfill_threads").get()).toEqual({ n: 0 });
    expect(env.db.prepare("SELECT count(*) AS n FROM backfill_run").get()).toEqual({ n: 0 });
    expect(await env.service.progress()).toEqual({ running: false, done: 0, total: 0 });
  });
});

describe("resume", () => {
  it("continues from the per-thread cursor after stop, without duplicates", async () => {
    let service!: ReturnType<typeof createBackfillService>;
    let stopped = false;
    env = await setup([thread({ id: "thr_s" }, 60)], { // 120 messages = 2 batches
      honcho: async () => {
        const { honchoPort } = await import("../../lib/backfill");
        const port = honchoPort(env!.client);
        return { ...port, createMessages: async (s, m) => { await port.createMessages(s, m); if (!stopped) { stopped = true; void service.stop(); } } } satisfies HonchoPort;
      },
    });
    service = env.service;
    await service.start(); await service.whenIdle();
    expect(env.mock.messages).toHaveLength(100);
    expect(await service.progress()).toMatchObject({ running: false, done: 100, total: 120 });
    await service.start(); await service.whenIdle();
    const keys = env.mock.messages.map(m => `${m.metadata.bb_seq}:${m.metadata.bb_part}`);
    expect(keys).toHaveLength(120);
    expect(new Set(keys).size).toBe(120);
    expect(await service.progress()).toMatchObject({ running: false, done: 20, total: 20 });
  });
  it("surfaces an auth failure in progress and stops", async () => {
    env = await setup([thread({ id: "thr_e" }, 1)]);
    env.mock.fault(401);
    await env.service.start(); await env.service.whenIdle();
    expect(await env.service.progress()).toMatchObject({ running: false, error: "auth" });
    expect(env.activity.some(a => a.kind === "failure")).toBe(true);
  });
});

describe("rate limit", () => {
  it("limiter spaces batches by messages per minute (fake timers)", async () => {
    vi.useFakeTimers();
    const limiter = new RateLimiter();
    const order: string[] = [];
    const run = (async () => { await limiter.take(100, 300); order.push("a"); await limiter.take(100, 300); order.push("b"); await limiter.take(10, 300); order.push("c"); })();
    await vi.advanceTimersByTimeAsync(0); expect(order).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(19_999); expect(order).toEqual(["a"]);
    await vi.advanceTimersByTimeAsync(1); expect(order).toEqual(["a", "b"]);
    await vi.advanceTimersByTimeAsync(20_000); expect(order).toEqual(["a", "b", "c"]);
    await run;
  });
  it("service sends one batch, then waits out the rate before the next", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const memory: HonchoPort = { sessionHasMessages: async () => false, listMessages: async () => [], ensureSession: async () => {}, createMessages: async (_s, m) => { sent.push(m.length); } };
    env = await setup([thread({ id: "thr_rl" }, 75)], { honcho: async () => memory, messagesPerMinute: () => 300, sleep: undefined });
    await env.service.start();
    await vi.advanceTimersByTimeAsync(1_000); expect(sent).toEqual([100]);
    await vi.advanceTimersByTimeAsync(18_000); expect(sent).toEqual([100]);
    await vi.advanceTimersByTimeAsync(2_000); await env.service.whenIdle();
    expect(sent).toEqual([100, 50]);
  });
  it("stop() interrupts a rate-limit wait", async () => {
    vi.useFakeTimers();
    const sent: number[] = [];
    const memory: HonchoPort = { sessionHasMessages: async () => false, listMessages: async () => [], ensureSession: async () => {}, createMessages: async (_s, m) => { sent.push(m.length); } };
    env = await setup([thread({ id: "thr_rs" }, 60)], { honcho: async () => memory, messagesPerMinute: () => 60, sleep: undefined });
    await env.service.start();
    await vi.advanceTimersByTimeAsync(1_000);
    await env.service.stop();
    expect(sent).toEqual([100]);
    expect((await env.service.progress()).running).toBe(false);
  });
});

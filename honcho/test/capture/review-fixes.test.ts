// Regression tests for defects two reviews confirmed in capture, backfill and the outbox.
// Synthetic content only.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBackfillService } from "../../lib/backfill";
import { createCaptureService, type CaptureHandle } from "../../lib/capture/service";
import { filesGitInfo } from "../../lib/capture/ports";
import { FactsUnavailable, scopeKey, threadFacts } from "../../lib/capture/scope";
import type { CaptureDeps } from "../../lib/capture/ports";
import { HonchoClient, HonchoError, type MessageDraft } from "../../lib/honcho-client";
import { Outbox } from "../../lib/outbox";
import { mockHoncho } from "../mock-honcho";
import { captureDeps, fakeBb, FakeClock } from "./fake-bb";

type Mock = Awaited<ReturnType<typeof mockHoncho>>;
let mock: Mock, clock: FakeClock, fake: ReturnType<typeof fakeBb>, stops: Array<() => void>;
beforeEach(async () => { mock = await mockHoncho(); clock = new FakeClock(); fake = fakeBb(clock); stops = []; });
afterEach(async () => { for (const stop of stops) stop(); fake.db.close(); await mock.close(); });

const GRACE = 30_000;
function service(over: Partial<CaptureDeps> = {}) {
  const deps = captureDeps(mock.baseUrl, fake.db, clock, over);
  const svc = createCaptureService(fake.bb, deps);
  stops.push(svc.start());
  return { svc, deps };
}
async function pass(svc: CaptureHandle, ms = GRACE + 1) { clock.advance(ms); await svc.flushNow(); }
/** Lets un-awaited work (deletes scheduled from catch-up) settle. */
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const sent = (thread = "thr_a") => mock.messages.filter(m => m.session_id === thread);
const texts = (thread = "thr_a") => sent(thread).map(m => m.content);
const deletes = (thread = "thr_a") => mock.requests.filter(r => r.method === "DELETE" && r.path.endsWith(`/sessions/${thread}`));
const idle = (id = "thr_a") => fake.emit("thread.idle", { thread: fake.threads.get(id) });
const privacyOn = { denyRemotes: [], denyPaths: [], patterns: [], deleteOnDelete: true, purgeConclusionsOnDelete: false };

describe("deletion while the plugin was down", () => {
  it("startup catch-up deletes the session of a thread bb deleted while nobody listened", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "conversation to be deleted");
    const outbox = new Outbox(fake.db);
    const first = service({ outbox });
    await pass(first.svc);
    expect(texts()).toEqual(["conversation to be deleted"]);
    stops.pop()!(); // reload or disable: thread.deleted fires while nobody listens
    fake.deleteThread("thr_a");
    const second = createCaptureService(fake.bb, captureDeps(mock.baseUrl, fake.db, clock, { outbox }));
    stops.push(second.start());
    await second.flushNow(); await settle();
    expect(deletes()).toHaveLength(1);
    expect(texts()).toEqual([]);
    expect(outbox.knownThreads()).toEqual([]);
    expect(await fake.bb.storage.kv.get("capture:pending-delete:thr_a")).toBeUndefined();
  });

  it("a thread that turns out deleted when its work runs is deleted too", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "hello");
    const { svc } = service();
    await pass(svc);
    fake.deleteThread("thr_a"); // the thread.deleted event was missed
    await idle();
    await pass(svc); await settle();
    expect(deletes()).toHaveLength(1);
  });

  it("never deletes a live thread that a list happened to leave out", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "still here");
    const outbox = new Outbox(fake.db);
    const first = service({ outbox });
    await pass(first.svc);
    stops.pop()!();
    const list = fake.bb.sdk.threads.list;
    fake.bb.sdk.threads.list = (async (args: { threadIds?: string[] }) => args.threadIds ? [] : list(args as never)) as typeof list;
    const second = createCaptureService(fake.bb, captureDeps(mock.baseUrl, fake.db, clock, { outbox }));
    stops.push(second.start());
    await second.flushNow(); await settle();
    expect(deletes()).toHaveLength(0);
    expect(texts()).toEqual(["still here"]);
  });
});

describe("deleting a session that never reached honcho", () => {
  it("treats the 404 as done and clears the pending delete instead of retrying forever", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "short-lived");
    const { deps } = service({ privacy: () => privacyOn });
    mock.fault(404); // DELETE /sessions/thr_a: deleted inside the grace window, no session was ever created
    fake.deleteThread("thr_a");
    await fake.emit("thread.deleted", { thread: fake.threads.get("thr_a") });
    clock.advance(10 * 60_000); await settle();
    expect(mock.requests.filter(r => r.method === "DELETE")).toHaveLength(1);
    expect(await fake.bb.storage.kv.get("capture:pending-delete:thr_a")).toBeUndefined();
    expect(deps.activity.entries.some(e => e.summary.includes("will retry"))).toBe(false);
    expect(deps.activity.entries.find(e => e.kind === "delete")?.summary).toContain("deleted the honcho session");
  });
});

describe("pausing inside the grace window", () => {
  it("stops a paste that is still waiting out the grace window, also after resuming", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "already sent");
    const { svc } = service();
    await pass(svc);
    fake.prompt("thr_a", "oops pasted secret");
    fake.agent("thr_a", "reply to the paste");
    await idle();
    clock.advance(5_000);
    await svc.setPaused({ kind: "thread", id: "thr_a" }, true);
    await pass(svc);
    expect(texts()).toEqual(["already sent"]);
    await svc.setPaused({ kind: "thread", id: "thr_a" }, false);
    fake.prompt("thr_a", "after resume");
    await idle();
    await pass(svc);
    expect(texts()).toEqual(["already sent", "after resume"]);
  });

  it("covers a batch that is queued after a failed upload", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "queued while offline");
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox });
    mock.fault(503); mock.fault(503); mock.fault(503); mock.fault(503); mock.fault(503);
    await pass(svc);
    expect(texts()).toEqual([]);
    await svc.setPaused({ kind: "thread", id: "thr_a" }, true);
    await svc.setPaused({ kind: "thread", id: "thr_a" }, false);
    await pass(svc); await pass(svc);
    expect(texts()).toEqual([]);
  });
});

describe("resuming while the event log can't be read", () => {
  it("closes the pause at the newest seq it knows of instead of dropping the range", async () => {
    fake.addThread("thr_a");
    const { svc } = service();
    await pass(svc);
    await svc.setPaused({ kind: "thread", id: "thr_a" }, true);
    fake.prompt("thr_a", "typed while paused");
    const last = fake.agent("thr_a", "reply while paused");
    await fake.emit("experimental_thread.events", { thread: fake.threads.get("thr_a"), sequence: last });
    const list = fake.bb.sdk.threads.events.list;
    fake.bb.sdk.threads.events.list = (async (args: { order?: string }) => {
      if (args.order === "desc") throw new Error("offline");
      return list(args as never);
    }) as typeof list;
    await svc.setPaused({ kind: "thread", id: "thr_a" }, false);
    fake.bb.sdk.threads.events.list = list;
    fake.prompt("thr_a", "after resume");
    await idle();
    await pass(svc);
    expect(texts()).toEqual(["after resume"]);
  });
});

describe("lookups that fail are not answers", () => {
  it("uploads nothing while the environment can't be read, then retries", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "private client conversation");
    const get = fake.bb.sdk.environments.get;
    fake.bb.sdk.environments.get = (async () => { throw new Error("host temporarily unavailable"); }) as typeof get;
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox, privacy: () => ({ ...privacyOn, denyPaths: ["/synthetic/elsewhere/**"] }) });
    await pass(svc);
    expect(texts()).toEqual([]);
    expect(outbox.cursor("thr_a")).toBe(0);
    expect(await svc.threadStatus("thr_a")).toMatchObject({ state: "not-captured", reason: expect.stringContaining("could not read") });
    fake.bb.sdk.environments.get = get;
    await svc.flushNow();
    expect(texts()).toEqual(["private client conversation"]);
  });

  it("never caches a failed .git read: no pinned 'no remote' and no pinned project scope", async () => {
    let offline = true;
    const files = { async read({ path }: { path: string }) {
      if (offline) throw Object.assign(new Error("host offline"), { status: 503, code: "host_unavailable" });
      if (path.endsWith("/.git/HEAD")) return { content: "ref: refs/heads/main\n", contentEncoding: "utf8" };
      if (path.endsWith("/.git/config")) return { content: '[remote "origin"]\n\turl = git@example.test:client/secret-repo.git\n', contentEncoding: "utf8" };
      throw Object.assign(new Error("missing"), { status: 404, code: "ENOENT" });
    } };
    const bb = { ...fake.bb, sdk: { ...fake.bb.sdk, files } } as unknown as typeof fake.bb;
    const facts = threadFacts(bb, filesGitInfo(files as never));
    const thread = { id: "thr_a", projectId: "proj_fixture", environmentId: "env_fixture" };
    const privacy = { ...privacyOn, denyRemotes: ["git@example.test:client/*"] };
    await expect(facts.denied(thread, privacy)).rejects.toBeInstanceOf(FactsUnavailable);
    await expect(facts.scopeFor(thread)).rejects.toBeInstanceOf(FactsUnavailable);
    expect(await fake.bb.storage.kv.get(scopeKey("thr_a"))).toBeUndefined();
    offline = false;
    expect(await facts.denied(thread, privacy)).toMatch(/deny list/);
    expect(await facts.scopeFor(thread)).toBe("fixture-repo");
  });

  it("filesGitInfo treats only not-found as absent", async () => {
    const read = filesGitInfo({ async read() { throw Object.assign(new Error("timeout"), { status: 504 }); } } as never);
    await expect(read({ hostId: "h", path: "/r" })).rejects.toThrow("timeout");
    const none = filesGitInfo({ async read() { throw Object.assign(new Error("gone"), { status: 404, code: "ENOENT" }); } } as never);
    expect(await none({ hostId: "h", path: "/r" })).toEqual({ commonDir: null, remote: null });
  });
});

describe("sender lookups", () => {
  it("holds the cursor on a transient failure and credits the sender once it resolves", async () => {
    fake.addThread("thr_sender", { providerId: "codex" });
    fake.addThread("thr_a");
    fake.prompt("thr_a", "message from sender", { initiator: "agent", senderThreadId: "thr_sender" });
    const get = fake.bb.sdk.threads.get;
    let fail = true;
    fake.bb.sdk.threads.get = (async (args: { threadId: string }) => {
      if (args.threadId === "thr_sender" && fail) throw new Error("transient unavailable");
      return get(args as never);
    }) as typeof get;
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox });
    await pass(svc);
    expect(outbox.cursor("thr_a")).toBe(0);
    fail = false;
    await svc.flushNow();
    expect(sent().map(m => [m.content, m.peer_id])).toEqual([["message from sender", "codex"]]);
  });

  it("still skips a sender bb doesn't know", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "from nowhere", { initiator: "agent", senderThreadId: "thr_unknown" });
    fake.prompt("thr_a", "user prompt");
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox });
    await pass(svc);
    expect(texts()).toEqual(["user prompt"]);
    expect(outbox.cursor("thr_a")).toBe(4);
  });
});

describe("splitting a rejected upload", () => {
  it("retries only the rejected POST; accepted chunks are never resent", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "x".repeat(25_000 * 102)); // 102 parts: POSTs of 100 and 2
    const calls: number[] = [];
    const client = async () => {
      const c = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test" });
      const create = c.createMessages.bind(c);
      c.createMessages = (async (session: string, rows: readonly MessageDraft[]) => {
        calls.push(rows.length);
        if (calls.length === 2) throw new HonchoError("validation", 422);
        return create(session, rows);
      }) as typeof c.createMessages;
      return c;
    };
    const { svc } = service({ client });
    await pass(svc);
    expect(calls).toEqual([100, 2, 1, 1]);
    const keys = sent().map(m => `${m.metadata.bb_seq}:${m.metadata.bb_part}`);
    expect(keys).toHaveLength(102);
    expect(new Set(keys).size).toBe(102);
  });
});

describe("tripwire", () => {
  const harnessMessage = async (name: string, at: number) => {
    const client = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test" });
    await client.createMessages(name, [{ peer_id: "hermy", content: "harness wrote this", created_at: new Date(at).toISOString() }]);
  };

  it("ignores what the harness wrote before the thread switched over", async () => {
    await harnessMessage("synthetic-session_abc", clock.now() - 60_000);
    fake.addThread("thr_a");
    fake.identity("thr_a", "synthetic-session_abc");
    fake.prompt("thr_a", "hi");
    fake.turnDone("thr_a");
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox });
    await pass(svc);
    expect((await svc.health()).tripwire).toBeNull();
  });

  it("fires when the harness keeps writing after the switch-over", async () => {
    await harnessMessage("synthetic-session_abc", clock.now() - 60_000);
    fake.addThread("thr_a");
    fake.identity("thr_a", "synthetic-session_abc");
    fake.prompt("thr_a", "hi");
    await harnessMessage("synthetic-session_abc", clock.now() + 500);
    fake.turnDone("thr_a");
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox });
    await pass(svc);
    expect((await svc.health()).tripwire).toContain("synthetic-session_abc");
  });
});

describe("backfill", () => {
  const backfill = (deps: ReturnType<typeof captureDeps>, over: Record<string, unknown> = {}) =>
    createBackfillService(fake.bb as never, { ...deps, sleep: async () => {}, messagesPerMinute: () => 6000, ...over });

  it("starts a fork at its fork boundary: copied history stays with the source thread", async () => {
    fake.addThread("thr_parent");
    fake.prompt("thr_parent", "parent historical message");
    fake.agent("thr_parent", "parent reply");
    clock.advance(1_000);
    fake.addThread("thr_fork", { originKind: "fork", sourceThreadId: "thr_parent" });
    for (const e of fake.logs.get("thr_parent")!) fake.append("thr_fork", e.type, e.data as never, e.createdAt);
    fake.prompt("thr_fork", "fork's own question");
    const svc = backfill(captureDeps(mock.baseUrl, fake.db, clock));
    await svc.start(); await svc.whenIdle();
    expect(mock.messages.filter(m => m.content === "parent historical message").map(m => m.session_id)).toEqual(["thr_parent"]);
    expect(texts("thr_fork")).toEqual(["fork's own question"]);
  });

  it("drops messages an edit deleted while it waited for the rate limit", async () => {
    fake.addThread("thr_a");
    for (let i = 0; i < 120; i++) fake.prompt("thr_a", `historical ${i}`); // prompt i at seq 2i+1
    let waited = false;
    const svc = backfill(captureDeps(mock.baseUrl, fake.db, clock), {
      messagesPerMinute: () => 1,
      sleep: async () => { if (!waited) { waited = true; fake.edit("thr_a", 201); } },
    });
    await svc.start(); await svc.whenIdle();
    expect(waited).toBe(true);
    expect(texts()).toHaveLength(100);
    expect(texts()).not.toContain("historical 100");
    expect(new Set(sent().map(m => m.metadata.bb_seq)).size).toBe(100);
  });

  it("skips paused and superseded drafts at send time", async () => {
    fake.addThread("thr_a");
    for (let i = 0; i < 120; i++) fake.prompt("thr_a", `historical ${i}`);
    const deps = captureDeps(mock.baseUrl, fake.db, clock);
    let waited = false;
    const svc = backfill(deps, { messagesPerMinute: () => 1, sleep: async () => { if (!waited) { waited = true; deps.outbox.supersede("thr_a", 201, 205); } } });
    await svc.start(); await svc.whenIdle();
    expect(texts()).toHaveLength(117);
    expect(texts()).not.toContain("historical 100");
  });

  it("skips gate-open threads live capture hasn't seen yet, and says so in the dry run", async () => {
    fake.addThread("thr_pi", { providerId: "pi" });
    fake.prompt("thr_pi", "pi history");
    fake.addThread("thr_cc");
    fake.prompt("thr_cc", "claude history");
    const deps = captureDeps(mock.baseUrl, fake.db, clock);
    const svc = backfill(deps);
    expect(await svc.dryRun()).toMatchObject({ threads: 1, notYetSeenByCapture: 1 });
    await svc.start(); await svc.whenIdle();
    expect(texts("thr_pi")).toEqual([]);
    expect(texts("thr_cc")).toEqual(["claude history"]);
    // Once live capture has claimed it, backfill covers what precedes the marker.
    deps.outbox.markSwitchOver("thr_pi", 2);
    expect(await svc.dryRun()).toMatchObject({ threads: 1, notYetSeenByCapture: 0 });
    await svc.start(); await svc.whenIdle();
    expect(texts("thr_pi")).toEqual(["pi history"]);
  });

  it("treats every thread as gate-open when capture doesn't require switch-over", async () => {
    fake.addThread("thr_cc");
    fake.prompt("thr_cc", "claude history");
    const svc = backfill(captureDeps(mock.baseUrl, fake.db, clock), { captureRequiresSwitchover: () => false });
    expect(await svc.dryRun()).toMatchObject({ threads: 0, notYetSeenByCapture: 1 });
  });
});

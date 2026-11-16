import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCaptureService, type CaptureHandle } from "../../lib/capture/service";
import { HonchoClient, HonchoError, type MessageDraft } from "../../lib/honcho-client";
import { Outbox } from "../../lib/outbox";
import { mockHoncho } from "../mock-honcho";
import { captureDeps, fakeBb, FakeClock } from "./fake-bb";
import type { CaptureDeps } from "../../lib/capture/ports";
import type { PrivacySettings } from "../../lib/contract";

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
/** Let the grace window pass and drain the work it released. */
async function pass(svc: CaptureHandle, ms = GRACE + 1) { clock.advance(ms); await svc.flushNow(); }
const sent = (thread = "thr_a") => mock.messages.filter(m => m.session_id === thread);
const texts = (thread = "thr_a") => sent(thread).map(m => m.content);
const posts = () => mock.requests.filter(r => r.method === "POST" && /\/sessions\/[^/]+\/messages$/.test(r.path));

describe("capture pipeline", () => {
  it("uploads after the grace window, lazily creating the session with scope, metadata and peers", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "please add a test");
    fake.agent("thr_a", "added it");
    fake.turnDone("thr_a");
    const { svc, deps } = service();
    clock.advance(10_000); await svc.flushNow();
    expect(sent()).toHaveLength(0);
    expect((await svc.health()).queued).toBe(2);
    expect((await svc.health()).oldestPendingAt).not.toBeNull();
    expect(mock.requests.some(r => /\/sessions$/.test(r.path))).toBe(false);

    await pass(svc);
    expect(texts()).toEqual(["please add a test", "added it"]);
    expect(sent().map(m => [m.peer_id, m.metadata.bb_seq, m.metadata.bb_part])).toEqual([["hermy", 1, 0], ["claude_code", 3, 0]]);
    const create = mock.requests.find(r => /\/sessions$/.test(r.path))!;
    expect(create.body).toMatchObject({
      id: "thr_a", scopes: ["fixture-repo"],
      peers: { hermy: { observe_me: true }, claude_code: { observe_me: false } },
      metadata: { provider: "claude-code", model: "fixture-model", host: "host_fixture", environment: "env_fixture", project: "proj_fixture" },
    });
    expect(await svc.scopeFor({ id: "thr_a", projectId: "proj_fixture", environmentId: "env_fixture" })).toBe("fixture-repo");
    expect(deps.activity.entries.find(e => e.kind === "upload")).toMatchObject({ threadId: "thr_a", messages: 2, redactions: 0, reasoning: true });
    expect(await svc.health()).toMatchObject({ queued: 0, oldestPendingAt: null, authFailing: false, tripwire: null });
    expect((await svc.threadStatus("thr_a")).state).toBe("idle");
    // A rerun sends nothing twice.
    await pass(svc);
    expect(sent()).toHaveLength(2);
  });

  it("only reads threads that bb reports, and uses renamed peers and redaction", async () => {
    fake.addThread("thr_a");
    const { svc, deps } = service({ config: async () => ({ config: { baseUrl: mock.baseUrl, apiKey: "", workspace: "test", peerName: "hermy" }, keys: ["synthetic-deny-value-42"], warnings: [] }) });
    await pass(svc);
    const reads = fake.listCalls.length;
    await fake.bb.storage.kv.set("ui.peers", { renames: { "claude-code": "claude_renamed" }, firstSeen: {} });
    fake.prompt("thr_a", "token synthetic-deny-value-42 here");
    fake.agent("thr_a", "ok");
    await pass(svc);
    expect(fake.listCalls.length).toBe(reads); // no bb event, no read
    await fake.emit("experimental_thread.events", { thread: fake.threads.get("thr_a"), sequence: 3 });
    await pass(svc);
    expect(texts()).toEqual(["token [REDACTED] here", "ok"]);
    expect(sent()[1].peer_id).toBe("claude_renamed");
    expect(deps.activity.entries.find(e => e.kind === "upload")?.redactions).toBe(1);
    expect((await fake.bb.storage.kv.get<any>("ui.peers")).firstSeen["claude-code"]).toBeTypeOf("number");
  });

  it("splits batches at 100 messages", async () => {
    fake.addThread("thr_a");
    for (let i = 0; i < 130; i++) fake.agent("thr_a", `reply ${i}`);
    const { svc } = service();
    await pass(svc);
    expect(sent()).toHaveLength(130);
    expect(posts().map(r => r.body.messages.length)).toEqual([100, 30]);
  });
});

/** A client whose message POSTs land in honcho, then hang until released: an upload in flight. */
function holdingClient(after: "before-post" | "after-post") {
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  let entered!: () => void;
  const inPost = new Promise<void>(r => { entered = r; });
  class Holding extends HonchoClient {
    override async createMessages(session: string, messages: readonly MessageDraft[]) {
      entered();
      if (after === "before-post") { await gate; return super.createMessages(session, messages); }
      const result = await super.createMessages(session, messages);
      await gate;
      return result;
    }
  }
  const client = new Holding({ baseUrl: mock.baseUrl, workspace: "test" });
  return { client: async () => client, release, inPost };
}

describe("reload overlap", () => {
  it("the new generation's catch-up waits for the old one's upload instead of posting twice", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "hello");
    fake.agent("thr_a", "hi there");
    const held = holdingClient("before-post");
    const old = service({ client: held.client, leaseOwner: "gen-old" });
    clock.advance(GRACE + 1);
    const oldDone = old.svc.flushNow();
    await held.inPost; // the old generation is mid-POST, lease held

    // Reload: the new generation registers and runs its startup catch-up on the same database.
    stops.shift()!();
    const next = service({ outbox: new Outbox(fake.db), leaseOwner: "gen-new" });
    await next.svc.flushNow();
    expect(posts()).toHaveLength(0); // the old POST is still held, the new one never started
    expect(next.deps.outbox.leaseOwner("thr_a", clock.now())).toBe("gen-old");

    held.release();
    await oldDone;
    expect(texts()).toEqual(["hello", "hi there"]);
    expect(next.deps.outbox.leaseOwner("thr_a", clock.now())).toBeUndefined();

    clock.advance(5_001); await next.svc.flushNow(); // the new generation's retry finds nothing left
    expect(posts()).toHaveLength(1);
    expect(texts()).toEqual(["hello", "hi there"]);
    expect(next.deps.outbox.inFlight()).toHaveLength(0);
    expect(next.deps.activity.entries.filter(e => e.kind === "failure")).toEqual([]);
  });

  it("recovers a dead generation's interrupted upload only after its lease expires, without resending", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "hello");
    const held = holdingClient("after-post"); // the POST lands, then the old generation hangs
    const old = service({ client: held.client, leaseOwner: "gen-old" });
    clock.advance(GRACE + 1);
    void old.svc.flushNow();
    await held.inPost;
    await vi.waitFor(() => expect(sent()).toHaveLength(1));

    const next = service({ outbox: new Outbox(fake.db), leaseOwner: "gen-new" });
    await next.svc.flushNow();
    expect(next.deps.outbox.inFlight("thr_a")).toHaveLength(1); // not recovered under a live lease

    clock.advance(60_001); await next.svc.flushNow(); // the old lease is stale now
    clock.advance(5_001); await next.svc.flushNow(); // and the new generation's next try takes it
    expect(next.deps.outbox.inFlight("thr_a")).toHaveLength(0);
    expect(posts()).toHaveLength(1); // recovery listed the landed messages and sent nothing again
    expect(texts()).toEqual(["hello"]);
    held.release();
  });

  it("never posts a thread whose lease another generation holds", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "hello");
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox, leaseOwner: "gen-old" });
    outbox.acquireLease("thr_a", "gen-other", clock.now() + GRACE + 1, 60_000);
    await pass(svc);
    expect(posts()).toHaveLength(0);
    expect(outbox.inFlight()).toHaveLength(0);
  });
});

describe("crash recovery", () => {
  it("does not resend after a crash between the POST and the cursor commit", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "first prompt");
    fake.agent("thr_a", "first reply");
    const outbox = new Outbox(fake.db);
    const crashing = Object.create(outbox) as Outbox;
    crashing.complete = () => { throw new Error("simulated crash"); };
    const first = service({ outbox: crashing });
    await pass(first.svc);
    expect(sent()).toHaveLength(2);
    expect(outbox.inFlight("thr_a")).toHaveLength(1);
    expect(outbox.cursor("thr_a")).toBe(0);
    stops.shift()!(); // the process dies

    fake.agent("thr_a", "second reply");
    const second = service({ outbox });
    await pass(second.svc); // startup reconcile + recovery
    expect(texts()).toEqual(["first prompt", "first reply", "second reply"]);
    expect(new Set(sent().map(m => `${m.metadata.bb_seq}:${m.metadata.bb_part}`)).size).toBe(3);
    expect(outbox.inFlight()).toHaveLength(0);
  });

  it("resends what never reached honcho when the POST itself failed, with backoff", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "hello");
    const outbox = new Outbox(fake.db);
    const { svc, deps } = service({ outbox });
    mock.fault(503); mock.fault(503); // the client retries a 5xx once
    await pass(svc);
    expect(sent()).toHaveLength(0);
    expect(outbox.retry("thr_a")?.attempts).toBe(1);
    expect((await svc.threadStatus("thr_a")).state).toBe("offline");
    expect(deps.activity.entries.filter(e => e.kind === "failure")).toHaveLength(1);
    clock.advance(1_000); await svc.flushNow();
    expect(texts()).toEqual(["hello"]);
    expect(outbox.retry("thr_a")).toBeUndefined();
    expect(outbox.inFlight()).toHaveLength(0);
  });

  it("flags auth failures in health", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "hello");
    const { svc } = service();
    mock.fault(401);
    await pass(svc);
    expect((await svc.health()).authFailing).toBe(true);
    await svc.flushNow();
    expect((await svc.health()).authFailing).toBe(false);
    expect(sent()).toHaveLength(1);
  });
});

describe("forks", () => {
  it("starts a fork's cursor after the copied parent events", async () => {
    const parentCreated = clock.now();
    fake.addThread("thr_parent", { createdAt: parentCreated });
    fake.prompt("thr_parent", "parent prompt");
    fake.agent("thr_parent", "parent reply");
    fake.turnDone("thr_parent");
    clock.advance(60_000);
    fake.addThread("thr_fork", { originKind: "fork", originPluginId: "side-chat", sourceThreadId: "thr_parent", visibility: "hidden" });
    // bb copies the parent's events with their original createdAt.
    for (const e of fake.logs.get("thr_parent")!) fake.append("thr_fork", e.type, e.data as any, e.createdAt);
    fake.prompt("thr_fork", "side question");
    fake.agent("thr_fork", "side answer");
    const outbox = new Outbox(fake.db);
    outbox.recordFirstStart(parentCreated - 1); // the plugin was already running when the parent was created
    const { svc } = service({ outbox });
    await pass(svc);
    expect(texts("thr_fork")).toEqual(["side question", "side answer"]);
    expect(texts("thr_parent")).toEqual(["parent prompt", "parent reply"]);
    expect(outbox.forkSource("thr_fork")).toEqual({ sourceThreadId: "thr_parent", boundarySeq: 4 });
    expect(mock.requests.find(r => r.body?.id === "thr_fork")?.body.metadata).toMatchObject({ sideChat: true, origin: "side-chat", parentThread: "thr_parent" });
  });
});

describe("edits", () => {
  it("drops queued seqs the edit deleted", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "first");
    fake.agent("thr_a", "first reply");
    fake.turnDone("thr_a");
    const { svc } = service();
    await pass(svc);
    const cutoff = fake.prompt("thr_a", "typo prompt");
    fake.agent("thr_a", "reply to typo");
    fake.edit("thr_a", cutoff);
    fake.prompt("thr_a", "fixed prompt");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(texts()).toEqual(["first", "first reply", "fixed prompt"]);
    expect(sent().some(m => m.metadata.bb_superseded)).toBe(false);
  });

  it("marks already-uploaded messages of the old branch superseded", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "keep me");
    fake.agent("thr_a", "kept");
    const cutoff = fake.prompt("thr_a", "old branch");
    fake.agent("thr_a", "old reply");
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox });
    await pass(svc);
    fake.edit("thr_a", cutoff);
    fake.prompt("thr_a", "new branch");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(sent().map(m => [m.content, !!m.metadata.bb_superseded])).toEqual([
      ["keep me", false], ["kept", false], ["old branch", true], ["old reply", true], ["new branch", false]]);
    expect(sent()[2].metadata).toMatchObject({ bb_thread: "thr_a", bb_seq: cutoff, bb_part: 0 });
    expect(outbox.isSuperseded("thr_a", cutoff)).toBe(true);
  });

  it("derives the deleted range from the seq gap when the event has no metadata", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "keep me");
    const cutoff = fake.prompt("thr_a", "old branch");
    const { svc } = service();
    await pass(svc);
    const op = fake.edit("thr_a", cutoff);
    const event = fake.logs.get("thr_a")!.find(e => e.seq === op)!;
    delete (event.data as any).metadata;
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(sent().map(m => [m.content, !!m.metadata.bb_superseded])).toEqual([["keep me", false], ["old branch", true]]);
  });
});

describe("pauses", () => {
  it("never uploads what was typed while paused, even when unpaused inside the grace window", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "before pause");
    const { svc } = service();
    await pass(svc);
    await svc.setPaused({ kind: "thread", id: "thr_a" }, true);
    expect((await svc.threadStatus("thr_a")).state).toBe("paused");
    expect(await svc.pauses()).toEqual([{ kind: "thread", id: "thr_a", since: clock.now() }]);
    fake.prompt("thr_a", "secret pasted while paused");
    fake.agent("thr_a", "reply while paused");
    clock.advance(5_000);
    await svc.setPaused({ kind: "thread", id: "thr_a" }, false);
    fake.prompt("thr_a", "after unpause");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(texts()).toEqual(["before pause", "after unpause"]);
    expect(await svc.pauses()).toEqual([]);
  });

  it("checks pauses at send time, and pauses whole projects by time", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "sent before the pause");
    const { svc } = service();
    await pass(svc);
    fake.prompt("thr_a", "queued then paused");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    clock.advance(1_000);
    await svc.setPaused({ kind: "project", id: "proj_fixture" }, true);
    await pass(svc);
    // Still inside the grace window when the project was paused: never uploaded.
    expect(texts()).toEqual(["sent before the pause"]);
    fake.prompt("thr_a", "during project pause");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect((await svc.threadStatus("thr_a")).state).toBe("paused");
    await svc.setPaused({ kind: "project", id: "proj_fixture" }, false);
    clock.advance(1);
    fake.prompt("thr_a", "after project pause");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    // Resuming doesn't release what was waiting when the pause began.
    expect(texts()).toEqual(["sent before the pause", "after project pause"]);
  });
});

describe("deny list", () => {
  it("skips threads whose git remote or path matches, for good", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "client work");
    let privacy: PrivacySettings = { denyRemotes: ["*acme/fixture-*"], denyPaths: [], patterns: [], deleteOnDelete: true, purgeConclusionsOnDelete: true };
    const { svc } = service({ privacy: () => privacy });
    await pass(svc);
    expect(sent()).toHaveLength(0);
    expect(await svc.threadStatus("thr_a")).toMatchObject({ state: "not-captured", reason: expect.stringContaining("deny list") });
    expect(await svc.isDenied({ id: "thr_a", projectId: "proj_fixture", environmentId: "env_fixture" })).toBe(true);
    privacy = { ...privacy, denyRemotes: [], denyPaths: ["/synthetic/work"] };
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(sent()).toHaveLength(0);
    privacy = { ...privacy, denyPaths: [] };
    fake.prompt("thr_a", "allowed again");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(texts()).toEqual(["allowed again"]);
  });
});

describe("deletion", () => {
  it("drops queued items, purges derived conclusions, deletes the session and logs it", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "remember this");
    fake.agent("thr_a", "noted");
    const outbox = new Outbox(fake.db);
    const { svc, deps } = service({ outbox });
    await pass(svc);
    const messageId = sent()[0].id;
    mock.conclusions.push(
      { id: "con_own", content: "explicit", observer_id: "hermy", observed_id: "hermy", session_id: "thr_a", level: "explicit" },
      { id: "con_derived", content: "derived", observer_id: "hermy", observed_id: "hermy", level: "deductive", source_ids: ["con_own"] },
      { id: "con_chain", content: "chain", observer_id: "hermy", observed_id: "hermy", level: "inductive", source_ids: ["con_derived"] },
      { id: "con_msg", content: "from message", observer_id: "hermy", observed_id: "hermy", level: "deductive", source_message_ids: [messageId] },
      { id: "con_other", content: "unrelated", observer_id: "hermy", observed_id: "hermy", level: "deductive", source_ids: ["con_elsewhere"] },
    );
    fake.prompt("thr_a", "typed just before delete");
    fake.deleteThread("thr_a");
    await fake.emit("thread.deleted", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(mock.requests.some(r => r.method === "DELETE" && r.path.endsWith("/sessions/thr_a"))).toBe(true);
    expect(mock.conclusions.map(c => c.id).sort()).toEqual(["con_msg", "con_other", "con_own"]); // con_own goes with the session cascade; source_message_ids are not followed
    expect(posts()).toHaveLength(1);
    expect(outbox.cursor("thr_a")).toBe(0);
    expect(deps.activity.entries.find(e => e.kind === "delete")?.summary).toContain("2 derived conclusion(s)");
  });

  it("purges conclusions honcho_conclude saved without a session, by id", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "hi");
    const { svc } = service({ unattachedConclusions: (id: string) => (id === "thr_a" ? ["con_loose"] : []) });
    await pass(svc);
    mock.conclusions.push(
      { id: "con_loose", content: "agent fact", observer_id: "hermy", observed_id: "hermy", level: "explicit" },
      { id: "con_from_loose", content: "derived", observer_id: "hermy", observed_id: "hermy", level: "deductive", source_ids: ["con_loose"] },
      { id: "con_keep", content: "unrelated", observer_id: "hermy", observed_id: "hermy", level: "explicit" },
    );
    fake.deleteThread("thr_a");
    await fake.emit("thread.deleted", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(mock.conclusions.map(c => c.id)).toEqual(["con_keep"]);
  });

  it("keeps the session when delete-on-delete is off", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "keep");
    const { svc, deps } = service({ privacy: () => ({ denyRemotes: [], denyPaths: [], patterns: [], deleteOnDelete: false, purgeConclusionsOnDelete: true }) });
    await pass(svc);
    fake.deleteThread("thr_a");
    await fake.emit("thread.deleted", { thread: fake.threads.get("thr_a") });
    expect(mock.requests.some(r => r.method === "DELETE")).toBe(false);
    expect(deps.activity.entries.find(e => e.kind === "delete")?.summary).toContain("kept");
  });
});

describe("switch-over gate", () => {
  it("captures only after a session build with BB_HONCHO, from the prompt that triggered it", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "harness still captures this");
    fake.envResolved("thr_a", ["PATH", "BB_THREAD_ID"]);
    fake.agent("thr_a", "old session reply");
    const done = fake.turnDone("thr_a");
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox, settings: () => ({}) });
    await pass(svc);
    expect(sent()).toHaveLength(0);
    expect(await svc.threadStatus("thr_a")).toMatchObject({ state: "not-captured", reason: expect.stringContaining("harness") });

    fake.build("thr_a", "first bb-captured prompt");
    fake.agent("thr_a", "new session reply");
    fake.turnDone("thr_a");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(texts()).toEqual(["first bb-captured prompt", "new session reply"]);
    expect(outbox.switchOver("thr_a")).toBe(done);
  });

  it("is always open for pi and acp providers", async () => {
    fake.addThread("thr_pi", { providerId: "pi" });
    fake.addThread("thr_acp", { providerId: "acp-fixture" });
    fake.prompt("thr_pi", "pi prompt");
    fake.prompt("thr_acp", "acp prompt");
    const { svc } = service({ settings: () => ({ captureRequiresSwitchover: true }) });
    await pass(svc);
    expect(texts("thr_pi")).toEqual(["pi prompt"]);
    expect(texts("thr_acp")).toEqual(["acp prompt"]);
  });
});

describe("tripwire", () => {
  const harnessSession = async (name: string, at = clock.now()) => {
    const client = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test" });
    await client.createMessages(name, [{ peer_id: "hermy", content: "harness wrote this", created_at: new Date(at).toISOString() }]);
  };

  it("fires when claude-honcho also wrote a session for the provider thread id", async () => {
    await harnessSession("synthetic-session_abc");
    fake.addThread("thr_a");
    fake.identity("thr_a", "Synthetic-Session_ABC");
    fake.prompt("thr_a", "hi");
    fake.agent("thr_a", "hello");
    fake.turnDone("thr_a");
    const { svc, deps } = service();
    await pass(svc);
    expect((await svc.health()).tripwire).toContain("synthetic-session_abc");
    expect(deps.activity.entries.some(e => e.kind === "harness" && e.error === "tripwire")).toBe(true);
  });

  it("fires on a codex chat-instance session, and stays quiet otherwise", async () => {
    fake.addThread("thr_a", { providerId: "codex" });
    fake.identity("thr_a", "0123456789abcdef");
    fake.prompt("thr_a", "hi");
    fake.turnDone("thr_a");
    const { svc } = service();
    await pass(svc);
    expect((await svc.health()).tripwire).toBeNull();

    await harnessSession("fixture-repo-01234567");
    fake.addThread("thr_b", { providerId: "codex" });
    fake.identity("thr_b", "0123456789abcdef");
    fake.prompt("thr_b", "hi");
    fake.turnDone("thr_b");
    await fake.emit("thread.created", { thread: fake.threads.get("thr_b") });
    await pass(svc);
    expect((await svc.health()).tripwire).toContain("fixture-repo-01234567");
  });
});

describe("poison batches", () => {
  /** A client whose server rejects (422) any batch containing the poison text. */
  const poisoned = (poison: string, calls: number[] = []) => async () => {
    const client = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test" });
    const create = client.createMessages.bind(client);
    client.createMessages = (async (session: string, messages: readonly MessageDraft[]) => {
      calls.push(messages.length);
      if (messages.some(m => m.content.includes(poison))) throw new HonchoError("validation", 422);
      return create(session, messages);
    }) as typeof client.createMessages;
    return client;
  };

  it("splits the batch, skips the single bad message, records it without content, and advances", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "one"); fake.agent("thr_a", "two");
    const badSeq = fake.agent("thr_a", "POISON content");
    fake.agent("thr_a", "four"); fake.agent("thr_a", "five");
    const last = fake.turnDone("thr_a");
    const outbox = new Outbox(fake.db);
    const calls: number[] = [];
    const { svc, deps } = service({ outbox, client: poisoned("POISON", calls) });
    await pass(svc);
    expect(texts()).toEqual(["one", "two", "four", "five"]);
    expect(outbox.cursor("thr_a")).toBeGreaterThanOrEqual(last - 1);
    expect(outbox.retry("thr_a")).toBeUndefined();
    expect(outbox.inFlight()).toHaveLength(0);
    expect(calls[0]).toBe(5); // the full batch first, then halves
    const skips = deps.activity.entries.filter(e => e.kind === "failure");
    expect(skips).toHaveLength(1);
    expect(skips[0].summary).toBe("skipped one message: rejected by honcho (validation)");
    expect(JSON.stringify(skips)).not.toContain("POISON");
    // Nothing is retried on the next pass.
    fake.prompt("thr_a", "later");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(texts()).toEqual(["one", "two", "four", "five", "later"]);
  });

  it("keeps the backoff for auth errors instead of splitting", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "one"); fake.agent("thr_a", "two");
    const outbox = new Outbox(fake.db);
    const calls: number[] = [];
    const client = async () => {
      const c = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test" });
      c.createMessages = (async (_s: string, m: readonly MessageDraft[]) => { calls.push(m.length); throw new HonchoError("auth", 401); }) as typeof c.createMessages;
      return c;
    };
    const { svc } = service({ outbox, client });
    await pass(svc);
    expect(calls).toEqual([2]);
    expect(outbox.retry("thr_a")?.lastError).toBe("auth");
    expect(outbox.cursor("thr_a")).toBe(0);
  });
});

describe("purge cost", () => {
  it("lists only the session's conclusions plus a bounded observer/observed scan, never the whole workspace", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "remember this");
    const { svc } = service();
    await pass(svc);
    mock.conclusions.push(
      { id: "con_own", content: "e", observer_id: "hermy", observed_id: "hermy", session_id: "thr_a", level: "explicit" },
      { id: "con_derived", content: "d", observer_id: "hermy", observed_id: "hermy", level: "deductive", source_ids: ["con_own"] },
      { id: "con_foreign", content: "f", observer_id: "someone", observed_id: "someone", level: "deductive", source_ids: ["con_own"] },
    );
    mock.requests.length = 0;
    fake.deleteThread("thr_a");
    await fake.emit("thread.deleted", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    const lists = mock.requests.filter(r => r.path.endsWith("/conclusions/list"));
    expect(lists.map(r => r.body.filters)).toEqual([{ session_id: "thr_a" }, { observer_id: "hermy", observed_id: "hermy" }]);
    expect(mock.conclusions.map(c => c.id).sort()).toEqual(["con_foreign", "con_own"]);
  });

  it("skips the scan when the session has no conclusions, and caps it at a bounded number of pages", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "x");
    const { svc, deps } = service();
    await pass(svc);
    mock.requests.length = 0;
    fake.deleteThread("thr_a");
    await fake.emit("thread.deleted", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(mock.requests.filter(r => r.path.endsWith("/conclusions/list"))).toHaveLength(1);
    expect(deps.activity.entries.find(e => e.kind === "delete")?.summary).toContain("0 derived");
  });

  it("stops scanning at the page cap and says so", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "x");
    const { svc, deps } = service();
    await pass(svc);
    mock.conclusions.push({ id: "con_own", content: "e", observer_id: "hermy", observed_id: "hermy", session_id: "thr_a", level: "explicit" });
    for (let i = 0; i < 5_200; i++) mock.conclusions.push({ id: `c${i}`, content: "d", observer_id: "hermy", observed_id: "hermy", level: "deductive", source_ids: ["nope"] });
    mock.requests.length = 0;
    fake.deleteThread("thr_a");
    await fake.emit("thread.deleted", { thread: fake.threads.get("thr_a") });
    await pass(svc);
    expect(mock.requests.filter(r => r.path.endsWith("/conclusions/list"))).toHaveLength(1 + 50);
    expect(deps.activity.entries.find(e => e.kind === "delete")?.summary).toContain("scan capped");
  });
});

describe("gate-open providers", () => {
  it("does not capture a pi thread that predates the plugin from seq 0 (backfill is opt-in)", async () => {
    const created = clock.now();
    fake.addThread("thr_old", { providerId: "pi", createdAt: created });
    fake.prompt("thr_old", "old prompt"); fake.agent("thr_old", "old reply");
    const old = fake.turnDone("thr_old");
    clock.advance(60_000);
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox, settings: () => ({ captureRequiresSwitchover: true }) });
    await pass(svc);
    expect(outbox.switchOver("thr_old")).toBe(old);
    expect(outbox.meta("first_started_at")).toBe(String(created + 60_000));
    expect(texts("thr_old")).toEqual([]);
    fake.prompt("thr_old", "new prompt");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_old") });
    await pass(svc);
    expect(texts("thr_old")).toEqual(["new prompt"]);
  });

  it("captures a thread created after the plugin started from the beginning", async () => {
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox, settings: () => ({ captureRequiresSwitchover: true }) });
    clock.advance(1_000);
    fake.addThread("thr_acp", { providerId: "acp-fixture" });
    fake.prompt("thr_acp", "first");
    await pass(svc);
    expect(outbox.switchOver("thr_acp")).toBe(0);
    expect(texts("thr_acp")).toEqual(["first"]);
  });
});

describe("pause since", () => {
  it("is stored in the outbox with the pause range, not in kv", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "x");
    const outbox = new Outbox(fake.db);
    const { svc } = service({ outbox });
    await svc.setPaused({ kind: "thread", id: "thr_a" }, true);
    expect(outbox.pauses()[0].sinceAt).toBe(clock.now());
    expect([...fake.kv.keys()].some(k => k.includes("pause-since"))).toBe(false);
    expect(await svc.pauses()).toEqual([{ kind: "thread", id: "thr_a", since: clock.now() }]);
  });

  it("re-evaluates held threads as soon as privacy changes, without waiting for a retry", async () => {
    fake.addThread("thr_a");
    fake.prompt("thr_a", "client work");
    let privacy: PrivacySettings = { denyRemotes: [], denyPaths: ["/synthetic/work"], patterns: [], deleteOnDelete: true, purgeConclusionsOnDelete: true };
    const { svc } = service({ privacy: () => privacy });
    await pass(svc);
    expect(await svc.threadStatus("thr_a")).toMatchObject({ state: "not-captured", reason: expect.stringContaining("deny list") });
    privacy = { ...privacy, denyPaths: [] };
    svc.privacyChanged();
    await svc.flushNow();
    expect((await svc.threadStatus("thr_a")).state).not.toBe("not-captured");
  });
});

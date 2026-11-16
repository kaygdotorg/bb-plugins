// The switch-over gate (session builds vs steers), probation before upload, and the
// re-evaluation of markers the old gate rule made. Event sequences are synthetic, shaped
// like the ones bb logs (see fake-bb.ts build/steer).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCaptureService, NOT_SWITCHED_OVER, PROBATION, type CaptureHandle } from "../../lib/capture/service";
import { HonchoClient } from "../../lib/honcho-client";
import { Outbox, OUTBOX_MIGRATIONS } from "../../lib/outbox";
import { mockHoncho } from "../mock-honcho";
import { captureDeps, fakeBb, FakeClock } from "./fake-bb";
import type { CaptureDeps } from "../../lib/capture/ports";

type Mock = Awaited<ReturnType<typeof mockHoncho>>;
let mock: Mock, clock: FakeClock, fake: ReturnType<typeof fakeBb>, stops: Array<() => void>;
beforeEach(async () => { mock = await mockHoncho(); clock = new FakeClock(); fake = fakeBb(clock); stops = []; });
afterEach(async () => { for (const stop of stops) stop(); fake.db.close(); await mock.close(); });

const GRACE = 30_000;
const TRIPWIRE = "capture:tripwire";
function service(over: Partial<CaptureDeps> = {}) {
  const outbox = new Outbox(fake.db);
  const deps = captureDeps(mock.baseUrl, fake.db, clock, { outbox, settings: () => ({}), ...over });
  const svc = createCaptureService(fake.bb, deps);
  stops.push(svc.start());
  return { svc, deps, outbox };
}
async function pass(svc: CaptureHandle, ms = GRACE + 1) { clock.advance(ms); await svc.flushNow(); }
const texts = (thread = "thr_a") => mock.messages.filter(m => m.session_id === thread).map(m => m.content);
const summaries = (deps: ReturnType<typeof captureDeps>) => deps.activity.entries.map(e => e.summary);
const harnessMessage = async (name: string, at: number) => {
  const client = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test" });
  await client.createMessages(name, [{ peer_id: "hermy", content: "harness wrote this", created_at: new Date(at).toISOString() }]);
};
/** A claude thread whose old session finished one turn before anything else happens. */
function oldSession(thread = "thr_a", providerId = "claude-code") {
  fake.addThread(thread, { providerId });
  fake.prompt(thread, "old session prompt");
  fake.agent(thread, "old session reply");
  return fake.turnDone(thread);
}

describe("switch-over gate", () => {
  it("doesn't switch over on a steer: no new process, so the harness keeps its old env", async () => {
    oldSession();
    fake.steer("thr_a", "steered into the running turn");
    fake.agent("thr_a", "reply in the old process");
    fake.turnDone("thr_a");
    const { svc, outbox } = service();
    await pass(svc); await pass(svc);
    expect(texts()).toEqual([]);
    expect(outbox.switchOver("thr_a")).toBeUndefined();
    expect(await svc.threadStatus("thr_a")).toMatchObject({ state: "not-captured", reason: NOT_SWITCHED_OVER });
  });

  it("switches over on a relaunch, from the prompt that triggered the build", async () => {
    oldSession();
    fake.steer("thr_a", "steer");
    const before = fake.turnDone("thr_a");
    fake.build("thr_a", "first prompt of the rebuilt session");
    fake.agent("thr_a", "new session reply");
    fake.turnDone("thr_a");
    const { svc, outbox } = service();
    await pass(svc);
    expect(outbox.switchOver("thr_a")).toBe(before);
    expect(texts()).toEqual(["first prompt of the rebuilt session", "new session reply"]);
  });

  it("switches over on a new thread's first build, and on a codex relaunch", async () => {
    fake.addThread("thr_new");
    fake.build("thr_new", "hello new thread", { newThread: true });
    fake.agent("thr_new", "hi");
    fake.turnDone("thr_new");
    const done = oldSession("thr_codex", "codex");
    fake.build("thr_codex", "codex relaunch");
    fake.turnDone("thr_codex");
    const { svc, outbox } = service();
    await pass(svc);
    expect(outbox.switchOver("thr_new")).toBe(0);
    expect(texts("thr_new")).toEqual(["hello new thread", "hi"]);
    expect(outbox.switchOver("thr_codex")).toBe(done);
    expect(texts("thr_codex")).toEqual(["codex relaunch"]);
  });

  it("ignores a build without BB_HONCHO, and a build whose input was accepted into a running turn first", async () => {
    oldSession();
    fake.build("thr_a", "harness on", { env: ["PATH"] });
    fake.turnDone("thr_a");
    const { requestId } = fake.request("thr_a", "joined a running turn");
    fake.accept("thr_a", requestId);
    fake.identity("thr_a", "prov_fixture");
    fake.envResolved("thr_a", ["BB_HONCHO"]);
    fake.turnDone("thr_a");
    const { svc, outbox } = service();
    await pass(svc);
    expect(outbox.switchOver("thr_a")).toBeUndefined();
    expect(texts()).toEqual([]);
  });
});

describe("probation", () => {
  it("holds uploads until the first turn after the build completed and the old plugin stayed quiet", async () => {
    oldSession();
    await harnessMessage("prov_fixture", clock.now() - 1_000); // the harness's own capture, before the build
    fake.build("thr_a", "rebuilt");
    fake.agent("thr_a", "still working");
    const { svc, deps, outbox } = service();
    await pass(svc); await pass(svc);
    expect(texts()).toEqual([]);
    expect(outbox.switchOverMarker("thr_a")?.probation).toBe(true);
    expect(await svc.threadStatus("thr_a")).toMatchObject({ state: "not-captured", reason: PROBATION });

    fake.turnDone("thr_a");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    clock.advance(GRACE / 2); await svc.flushNow();
    expect(texts()).toEqual([]);
    await pass(svc);
    expect(texts()).toEqual(["rebuilt", "still working"]);
    expect(outbox.switchOverMarker("thr_a")?.probation).toBe(false);
    expect((await svc.threadStatus("thr_a")).state).not.toBe("not-captured");
    expect(summaries(deps).some(s => s.includes("stayed quiet"))).toBe(true);
    expect((await svc.health()).tripwire).toBeNull();
  });

  it("drops the marker when the harness writes after the build; only a newer build switches over", async () => {
    oldSession();
    fake.build("thr_a", "looked rebuilt");
    const wroteAt = clock.now() + 500;
    await harnessMessage("prov_fixture", wroteAt);
    fake.agent("thr_a", "reply");
    fake.turnDone("thr_a");
    const first = service();
    await pass(first.svc);
    expect(texts()).toEqual([]);
    expect(first.outbox.switchOver("thr_a")).toBeUndefined();
    expect(first.outbox.harnessSeenAt("thr_a")).toBe(wroteAt);
    expect((await first.svc.health()).tripwire).toContain("prov_fixture");
    expect(await first.svc.threadStatus("thr_a")).toMatchObject({ state: "not-captured", reason: expect.stringContaining("wrote at") });
    expect(summaries(first.deps).some(s => s.includes("probation failed"))).toBe(true);

    // A new generation rescans from seq 0: the old build is not newer than the harness write.
    first.svc.stop();
    const second = service();
    await pass(second.svc);
    expect(second.outbox.switchOver("thr_a")).toBeUndefined();

    clock.advance(60_000);
    const before = fake.turnDone("thr_a");
    fake.build("thr_a", "really rebuilt");
    fake.turnDone("thr_a");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(second.svc);
    expect(second.outbox.switchOver("thr_a")).toBe(before);
    expect(texts()).toEqual(["really rebuilt"]);
    expect((await second.svc.health()).tripwire).toBeNull();
  });
});

describe("gate v1 markers", () => {
  /** An outbox at schema v4 (before gate versions), as live installs have it. */
  function v4Outbox(rows: Array<[string, number]>, cursors: Array<[string, number]>) {
    fake.db.exec("CREATE TABLE honcho_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (let i = 0; i < 4; i++) { fake.db.exec(OUTBOX_MIGRATIONS[i]); fake.db.prepare("INSERT INTO honcho_migrations VALUES (?,0)").run(i + 1); }
    for (const [t, s] of rows) fake.db.prepare("INSERT INTO switch_over VALUES (?,?)").run(t, s);
    for (const [t, s] of cursors) fake.db.prepare("INSERT INTO cursors VALUES (?,?)").run(t, s);
  }

  it("moves a marker the old gate set on a steer to the real build, keeps cursors, and clears the stale tripwire", async () => {
    const steerMarker = oldSession("thr_moved");
    fake.steer("thr_moved", "steer");
    fake.agent("thr_moved", "double-captured reply");
    const before = fake.turnDone("thr_moved");
    fake.build("thr_moved", "rebuilt");
    const uploaded = fake.agent("thr_moved", "already uploaded by the old gate");
    fake.agent("thr_moved", "not yet uploaded");
    fake.turnDone("thr_moved");

    const onlySteer = oldSession("thr_dropped");
    fake.steer("thr_dropped", "steer only");
    fake.turnDone("thr_dropped");

    fake.addThread("thr_pi", { providerId: "pi" });
    fake.prompt("thr_pi", "pi prompt");

    v4Outbox([["thr_moved", steerMarker], ["thr_dropped", onlySteer], ["thr_pi", 0]], [["thr_moved", uploaded], ["thr_dropped", onlySteer + 3]]);
    fake.kv.set(TRIPWIRE, 'harness session "prov_fixture" is still capturing thread thr_moved');
    fake.kv.set("capture:tripwire-checked:thr_moved", true);
    clock.advance(GRACE + 1);
    const { svc, deps, outbox } = service();
    await svc.flushNow(); await pass(svc);

    expect(outbox.switchOverMarker("thr_moved")).toMatchObject({ startSeq: before, gateVersion: 2, probation: false });
    expect(outbox.cursor("thr_moved")).toBeGreaterThan(uploaded);
    expect(texts("thr_moved")).toEqual(["not yet uploaded"]);
    expect(fake.kv.has(TRIPWIRE)).toBe(false);
    expect((await svc.health()).tripwire).toBeNull();

    expect(outbox.switchOver("thr_dropped")).toBeUndefined();
    expect(outbox.cursor("thr_dropped")).toBe(onlySteer + 3);
    expect(await svc.threadStatus("thr_dropped")).toMatchObject({ state: "not-captured", reason: NOT_SWITCHED_OVER });

    expect(outbox.switchOverMarker("thr_pi")).toMatchObject({ startSeq: 0, gateVersion: 2, probation: false });
    expect(texts("thr_pi")).toEqual(["pi prompt"]);
    expect(outbox.staleSwitchOvers()).toEqual([]);
    expect(summaries(deps).filter(s => s.includes("stricter gate"))).toHaveLength(2);
  });

  it("keeps a tripwire about a thread whose marker the re-evaluation doesn't change", async () => {
    fake.addThread("thr_new");
    fake.build("thr_new", "hello", { newThread: true });
    fake.turnDone("thr_new");
    v4Outbox([["thr_new", 0]], [["thr_new", 0]]);
    fake.kv.set(TRIPWIRE, 'harness session "prov_fixture" is still capturing thread thr_new');
    await harnessMessage("prov_fixture", clock.now() + 1); // still writing after the build
    clock.advance(GRACE + 1);
    const { svc, outbox } = service();
    await svc.flushNow(); await pass(svc);
    expect(outbox.switchOver("thr_new")).toBeUndefined();
    expect((await svc.health()).tripwire).toContain("thr_new");
    expect(texts("thr_new")).toEqual([]);
  });
});

describe("hand over", () => {
  const state = (handedOver: boolean, at?: number): import("../../lib/contract").HarnessState => ({
    machineId: "host_fixture",
    claude: { hookInstalled: true, handedOver, pluginVersion: null },
    codex: { hookInstalled: true, handedOver, trusted: true },
    backups: at === undefined ? [] : [`000001-${new Date(at).toISOString().replace(/[:.]/g, "-")}-handover`],
  });
  let handed: { on: boolean; at?: number };
  beforeEach(() => { handed = { on: false }; });
  /** The hand over happens now; the harness service's activity entry refreshes capture's cache. */
  const handOver = (deps: { activity: { record(e: { kind: "harness"; summary: string }): void } }) => {
    clock.advance(10_000);
    handed = { on: true, at: clock.now() };
    clock.advance(1_000);
    deps.activity.record({ kind: "harness", summary: "handed over" });
  };
  const withHarness = () => service({ harnessState: async () => state(handed.on, handed.at) });
  /** A probation failure: the old plugin wrote after the build. Returns when it wrote. */
  async function tripped(svc: CaptureHandle) {
    oldSession();
    fake.build("thr_a", "looked rebuilt");
    const wroteAt = clock.now() + 500;
    await harnessMessage("prov_fixture", wroteAt);
    fake.agent("thr_a", "reply");
    fake.turnDone("thr_a");
    await pass(svc);
    return wroteAt;
  }

  it("says to hand over, or restart the chat, while the machine isn't handed over", async () => {
    const { svc } = withHarness();
    await tripped(svc);
    const text = (await svc.health()).tripwire!;
    expect(text).toContain("the old claude honcho plugin is still saving chat thr_a.");
    expect(text).toContain("hand over on this machine (Memory → connection) or restart that chat");
  });

  it("clears a tripwire and harness write from before the hand over, and the next build switches the thread over", async () => {
    const { svc, deps, outbox } = withHarness();
    const wroteAt = await tripped(svc);
    expect(outbox.harnessSeenAt("thr_a")).toBe(wroteAt);
    expect((await svc.health()).tripwire).not.toBeNull();

    handOver(deps);
    await pass(svc);
    expect(outbox.harnessSeenAt("thr_a")).toBeUndefined();
    expect((await svc.health()).tripwire).toBeNull();
    expect(texts()).toEqual([]); // the old build doesn't count: it predates the hand over
    expect(outbox.switchOver("thr_a")).toBeUndefined();

    const before = fake.turnDone("thr_a");
    fake.build("thr_a", "rebuilt after hand over");
    fake.turnDone("thr_a");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc); await pass(svc);
    expect(outbox.switchOver("thr_a")).toBe(before);
    expect(texts()).toEqual(["rebuilt after hand over"]);
  });

  it("keeps the tripwire when the old plugin writes after the hand over, and says so", async () => {
    const { svc, deps, outbox } = withHarness();
    await tripped(svc);
    handOver(deps);
    await pass(svc);
    expect((await svc.health()).tripwire).toBeNull();

    fake.build("thr_a", "rebuilt after hand over");
    await harnessMessage("prov_fixture", clock.now() + 5_000);
    fake.turnDone("thr_a");
    await fake.emit("thread.idle", { thread: fake.threads.get("thr_a") });
    await pass(svc); await pass(svc);
    const text = (await svc.health()).tripwire!;
    expect(text).toContain("still saves chat thr_a even after hand over");
    expect(outbox.harnessSeenAt("thr_a")).toBeDefined();
    expect(texts()).toEqual([]);
  });

  it("refreshes on harness activity instead of waiting for the cache to expire", async () => {
    const { svc, deps, outbox } = withHarness();
    await tripped(svc);
    await pass(svc, 1_000); // cached: not handed over
    expect(outbox.harnessSeenAt("thr_a")).toBeDefined();
    handOver(deps);
    await pass(svc, 1_000);
    expect(outbox.harnessSeenAt("thr_a")).toBeUndefined();
  });
});

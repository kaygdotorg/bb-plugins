import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrateOutbox, openOutbox, Outbox, OUTBOX_MIGRATIONS } from "../lib/outbox";
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() { const db = new Database(":memory:"); databases.push(db); return { db, outbox: new Outbox(db) }; }
describe("content-free outbox", () => {
  it("migrates once across repeated initialization", () => {
    const { db, outbox } = setup(); outbox.advance("thread", 5);
    migrateOutbox(db); const reopened = new Outbox(db);
    expect(reopened.cursor("thread")).toBe(5);
    expect(db.prepare("SELECT version FROM honcho_migrations").all()).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }]);
  });
  it("rejects future schema versions", () => {
    const { db } = setup(); db.prepare(`INSERT INTO honcho_migrations VALUES (${OUTBOX_MIGRATIONS.length + 1},0)`).run();
    expect(() => migrateOutbox(db)).toThrow("Unsupported");
  });
  it("upload leases: one owner at a time across connections; expired leases are taken over", () => {
    const dir = mkdtempSync(join(tmpdir(), "honcho-lease-"));
    try {
      const a = new Database(join(dir, "data.db")), b = new Database(join(dir, "data.db"));
      databases.push(a, b);
      const old = new Outbox(a), next = new Outbox(b);
      expect(old.acquireLease("t", "gen-old", 1_000, 60_000)).toBe(true);
      expect(next.acquireLease("t", "gen-new", 2_000, 60_000)).toBe(false);
      expect(next.leaseOwner("t", 2_000)).toBe("gen-old");
      expect(old.acquireLease("t", "gen-old", 30_000, 60_000)).toBe(true); // renewal
      expect(next.acquireLease("t", "gen-new", 61_000, 60_000)).toBe(false); // renewed, still live
      expect(next.acquireLease("t", "gen-new", 90_000, 60_000)).toBe(true); // stale: taken over
      old.releaseLease("t", "gen-old"); // not the holder any more: no effect
      expect(next.leaseOwner("t", 90_001)).toBe("gen-new");
      next.releaseLeases("gen-new");
      expect(old.leaseOwner("t", 90_001)).toBeUndefined();
      expect(old.acquireLease("t", "gen-old", 90_002, 60_000)).toBe(true);
      old.deleteThread("t");
      expect(next.leaseOwner("t", 90_003)).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("clears retry state without moving the cursor", () => {
    const { outbox } = setup(); outbox.advance("t", 4); outbox.fail("t", "offline", 0);
    expect(outbox.retry("t")).toBeDefined();
    outbox.clearRetry("t");
    expect(outbox.retry("t")).toBeUndefined(); expect(outbox.cursor("t")).toBe(4);
  });
  it("records the first start time once", () => {
    const { outbox } = setup();
    expect(outbox.recordFirstStart(100)).toBe(100); expect(outbox.recordFirstStart(200)).toBe(100);
    expect(outbox.meta("first_started_at")).toBe("100");
  });
  it("migrates v2 pause ranges: project pauses get since_at from their start", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE honcho_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    for (let i = 0; i < 2; i++) { db.exec(OUTBOX_MIGRATIONS[i]); db.prepare("INSERT INTO honcho_migrations VALUES (?,0)").run(i + 1); }
    db.exec("INSERT INTO pause_ranges VALUES ('project','p',500,NULL),('thread','t',3,NULL)");
    const outbox = new Outbox(db);
    expect(outbox.pauses().map(r => [r.id, r.sinceAt])).toEqual([["p", 500], ["t", null]]);
  });
  it("advances cursors monotonically and rejects invalid sequences", () => {
    const { outbox } = setup(); expect(outbox.cursor("thread")).toBe(0);
    outbox.advance("thread", 10); outbox.advance("thread", 5); expect(outbox.cursor("thread")).toBe(10);
    for (const invalid of [-1, 1.5, NaN, Infinity]) expect(() => outbox.advance("thread", invalid)).toThrow();
  });
  it("keeps an in-flight range across reopen, and clears it atomically on completion", () => {
    const { db, outbox } = setup(); const marker = { thread: "thread", firstSeq: 1, lastSeq: 8, startedAt: 100 };
    outbox.begin(marker); outbox.fail("thread", "offline", 200);
    const reopened = new Outbox(db); expect(reopened.inFlight()).toEqual([marker]);
    expect(() => reopened.begin(marker)).toThrow();
    expect(() => reopened.complete("thread", 7)).toThrow();
    expect(reopened.cursor("thread")).toBe(0); expect(reopened.inFlight()).toEqual([marker]);
    reopened.complete("thread", 8); expect(reopened.cursor("thread")).toBe(8);
    expect(reopened.inFlight("thread")).toEqual([]); expect(reopened.retry("thread")).toBeUndefined();
  });
  it("rejects invalid marker ranges without writes", () => {
    const { outbox } = setup(); expect(() => outbox.begin({ thread: "thread", firstSeq: 9, lastSeq: 8, startedAt: 100 })).toThrow();
    expect(outbox.inFlight()).toEqual([]);
  });
  it("stores bounded exponential backoff and fixed error categories", () => {
    const { outbox, db } = setup();
    expect(outbox.fail("thread", "offline", 100)).toEqual({ attempts: 1, nextAt: 1100, lastError: "offline" });
    expect(outbox.fail("thread", "rate-limited", 100)).toEqual({ attempts: 2, nextAt: 2100, lastError: "rate-limited" });
    for (let i = 0; i < 30; i++) outbox.fail("thread", "server", 100);
    expect(outbox.retry("thread")?.nextAt).toBe(300100);
    outbox.fail("thread", "private message pasted into an error" as never, 100);
    expect(JSON.stringify(db.prepare("SELECT * FROM retries").all())).not.toContain("private message");
  });
  it("keeps the first switch-over marker", () => {
    const { outbox } = setup(); expect(outbox.switchOver("thread")).toBeUndefined();
    outbox.markSwitchOver("thread", 10); outbox.markSwitchOver("thread", 20); expect(outbox.switchOver("thread")).toBe(10);
  });
  it("stores thread pauses as seq ranges checked at send time", () => {
    const { outbox } = setup();
    outbox.setPaused("thread", "t", true, 10, 1234);
    expect(outbox.isPausedNow("thread", "t")).toBe(true);
    expect([10, 11, 500].map(n => outbox.isPaused("t", n))).toEqual([false, true, true]);
    // Unpausing inside the grace window never uploads what was typed while paused.
    outbox.setPaused("thread", "t", false, 14);
    expect([10, 11, 14, 15].map(n => outbox.isPaused("t", n))).toEqual([false, true, true, false]);
    expect(outbox.isPausedNow("thread", "t")).toBe(false);
    expect(outbox.pauses()).toEqual([{ kind: "thread", id: "t", from: 11, to: 14, sinceAt: 1234 }]);
    // A second pause adds a separate range; pausing twice does not.
    outbox.setPaused("thread", "t", true, 20); outbox.setPaused("thread", "t", true, 25);
    expect(outbox.pauses().map(r => [r.from, r.to])).toEqual([[11, 14], [21, null]]);
    expect(outbox.isPaused("other", 12)).toBe(false);
  });
  it("drops an empty pause range when nothing happened while paused", () => {
    const { outbox } = setup(); outbox.setPaused("thread", "t", true, 5); outbox.setPaused("thread", "t", false, 5);
    expect(outbox.pauses()).toEqual([]); expect(outbox.isPaused("t", 6)).toBe(false);
  });
  it("stores project pauses as createdAt ranges across threads", () => {
    const { outbox } = setup(); outbox.setPaused("project", "p", true, 1_000);
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 999 })).toBe(false);
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 1_000 })).toBe(true);
    expect(outbox.isPaused("b", 1, { id: "q", createdAt: 5_000 })).toBe(false);
    outbox.setPaused("project", "p", false, 2_000);
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 2_000 })).toBe(true);
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 2_001 })).toBe(false);
  });
  it("pauses a project item when the pause overlapped its wait between creation and send", () => {
    const { outbox } = setup(); outbox.setPaused("project", "p", true, 1_000);
    // Created before the pause, sent after it began: paused.
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 900, sendAt: 1_100 })).toBe(true);
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 900 })).toBe(false); // point check (backfill)
    outbox.setPaused("project", "p", false, 2_000);
    // Waiting when the pause began and sent after resuming: still never sent.
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 900, sendAt: 3_000 })).toBe(true);
    // Created after the resume, or sent before the pause: not paused.
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 2_001, sendAt: 3_000 })).toBe(false);
    expect(outbox.isPaused("a", 1, { id: "p", createdAt: 500, sendAt: 999 })).toBe(false);
    expect(outbox.shouldSend("a", 1, { id: "p", createdAt: 900, sendAt: 3_000 })).toBe(false);
  });
  it("lists the threads it holds state for, and the newest seq it knows per thread", () => {
    const { outbox } = setup();
    outbox.advance("a", 4); outbox.markSwitchOver("b", 9); outbox.begin({ thread: "c", firstSeq: 3, lastSeq: 7, startedAt: 1 });
    outbox.setForkSource("d", "a", 2); outbox.supersede("a", 5, 12);
    expect(outbox.knownThreads()).toEqual(["a", "b", "c", "d"]);
    expect(["a", "b", "c", "d", "none"].map(t => outbox.newestKnownSeq(t))).toEqual([12, 9, 7, 2, 0]);
    outbox.setPaused("thread", "t", true, 3);
    expect(outbox.openPause("thread", "t")).toMatchObject({ from: 4, to: null });
    outbox.deleteThread("c");
    expect(outbox.knownThreads()).toEqual(["a", "b", "d"]);
  });
  it("migrates v1 flag pauses into open ranges", () => {
    const db = new Database(":memory:"); databases.push(db);
    db.exec("CREATE TABLE honcho_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    db.exec(OUTBOX_MIGRATIONS[0]); db.prepare("INSERT INTO honcho_migrations VALUES (1,0)").run();
    db.prepare("INSERT INTO pauses VALUES ('thread','t'), ('project','p')").run();
    const outbox = new Outbox(db);
    expect(outbox.isPaused("t", 3)).toBe(true); expect(outbox.isPausedNow("project", "p")).toBe(true);
  });
  it("starts a fork's cursor after the copied parent events", () => {
    const { outbox } = setup(); outbox.advance("fork", 2);
    outbox.setForkSource("fork", "parent", 40);
    expect(outbox.forkSource("fork")).toEqual({ sourceThreadId: "parent", boundarySeq: 40 });
    expect(outbox.cursor("fork")).toBe(40);
    outbox.setForkSource("fork", "other", 99); // the first boundary wins
    expect(outbox.forkSource("fork")).toEqual({ sourceThreadId: "parent", boundarySeq: 40 }); expect(outbox.cursor("fork")).toBe(40);
    expect(outbox.forkSource("none")).toBeUndefined();
  });
  it("records superseded seq ranges so queued items from the old branch are dropped", () => {
    const { outbox } = setup();
    outbox.supersede("t", 5, 9);
    expect([4, 5, 9, 10].map(n => outbox.isSuperseded("t", n))).toEqual([false, true, true, false]);
    expect([4, 7, 10].map(n => outbox.shouldSend("t", n))).toEqual([true, false, true]);
    outbox.supersede("t", 5, 12); expect(outbox.supersededRanges("t")).toEqual([{ from: 5, to: 12 }]);
    expect(outbox.isSuperseded("other", 7)).toBe(false);
    expect(() => outbox.supersede("t", 9, 5)).toThrow();
    outbox.setPaused("thread", "t", true, 20); expect(outbox.shouldSend("t", 21)).toBe(false);
  });
  it("keeps several provider thread ids per thread, once each", () => {
    const { outbox } = setup();
    outbox.addProviderThread("t", "p1"); outbox.addProviderThread("t", "p2"); outbox.addProviderThread("t", "p1"); outbox.addProviderThread("t", "");
    expect(outbox.providerThreads("t")).toEqual(["p1", "p2"]); expect(outbox.providerThreads("x")).toEqual([]);
  });
  it("deletes a thread's state, preserving other threads and project pauses", () => {
    const { outbox } = setup();
    outbox.advance("thread", 3); outbox.begin({ thread: "thread", firstSeq: 4, lastSeq: 5, startedAt: 100 });
    outbox.fail("thread", "offline", 100); outbox.markSwitchOver("thread", 1);
    outbox.setForkSource("thread", "parent", 2); outbox.supersede("thread", 3, 4); outbox.addProviderThread("thread", "p");
    outbox.setPaused("thread", "thread", true, 0); outbox.setPaused("project", "project", true, 10); outbox.advance("other", 9);
    outbox.deleteThread("thread"); expect(outbox.cursor("thread")).toBe(0); expect(outbox.inFlight()).toEqual([]);
    expect(outbox.retry("thread")).toBeUndefined(); expect(outbox.switchOver("thread")).toBeUndefined();
    expect(outbox.forkSource("thread")).toBeUndefined(); expect(outbox.supersededRanges("thread")).toEqual([]); expect(outbox.providerThreads("thread")).toEqual([]);
    expect(outbox.isPaused("thread", 1)).toBe(false);
    expect(outbox.isPaused("other", 1, { id: "project", createdAt: 11 })).toBe(true); expect(outbox.cursor("other")).toBe(9);
  });
  it("contains no message/content columns", () => {
    const { db } = setup();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name).sort()).toEqual(["cursors", "fork_sources", "honcho_migrations", "in_flight", "leases", "meta", "pause_ranges", "provider_threads", "retries", "superseded", "switch_over"]);
    for (const { name } of tables) {
      const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
      expect(columns.some(c => /content|body|message|payload/.test(c.name))).toBe(false);
    }
  });
  it("uses the real bb.storage.database handle and survives reload", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "honcho" });
    try {
      openOutbox(bb.storage).advance("thread", 12);
      await harness.lifecycle.reload(next => { expect(openOutbox(next.storage).cursor("thread")).toBe(12); });
    } finally { await harness.lifecycle.dispose(); }
  });
});

import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrateOutbox, openOutbox, Outbox } from "../lib/outbox";
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup() { const db = new Database(":memory:"); databases.push(db); return { db, outbox: new Outbox(db) }; }
describe("content-free outbox", () => {
  it("migrates once across repeated initialization", () => {
    const { db, outbox } = setup(); outbox.advance("thread", 5);
    migrateOutbox(db); const reopened = new Outbox(db);
    expect(reopened.cursor("thread")).toBe(5);
    expect(db.prepare("SELECT version FROM honcho_migrations").all()).toEqual([{ version: 1 }]);
  });
  it("rejects future schema versions", () => {
    const { db } = setup(); db.prepare("INSERT INTO honcho_migrations VALUES (2,0)").run();
    expect(() => migrateOutbox(db)).toThrow("Unsupported");
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
  it("pauses independently by project and thread", () => {
    const { outbox } = setup(); outbox.setPaused("project", "project", true);
    expect(outbox.isPaused("thread", "project")).toBe(true); expect(outbox.isPaused("thread")).toBe(false);
    outbox.setPaused("thread", "thread", true); outbox.setPaused("project", "project", false);
    expect(outbox.isPaused("thread", "project")).toBe(true); outbox.setPaused("thread", "thread", false);
    expect(outbox.isPaused("thread", "project")).toBe(false);
  });
  it("deletes a thread's state, preserving other threads and project pauses", () => {
    const { outbox } = setup();
    outbox.advance("thread", 3); outbox.begin({ thread: "thread", firstSeq: 4, lastSeq: 5, startedAt: 100 });
    outbox.fail("thread", "offline", 100); outbox.markSwitchOver("thread", 1);
    outbox.setPaused("thread", "thread", true); outbox.setPaused("project", "project", true); outbox.advance("other", 9);
    outbox.deleteThread("thread"); expect(outbox.cursor("thread")).toBe(0); expect(outbox.inFlight()).toEqual([]);
    expect(outbox.retry("thread")).toBeUndefined(); expect(outbox.switchOver("thread")).toBeUndefined();
    expect(outbox.isPaused("thread")).toBe(false); expect(outbox.isPaused("other", "project")).toBe(true); expect(outbox.cursor("other")).toBe(9);
  });
  it("contains no message/content columns", () => {
    const { db } = setup();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
    expect(tables.map(t => t.name).sort()).toEqual(["cursors", "honcho_migrations", "in_flight", "pauses", "retries", "switch_over"]);
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

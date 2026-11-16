import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ACTIVITY_CAPACITY, openActivityLog, RingActivityLog, SqliteActivityLog } from "../lib/activity";

describe("activity ring buffer", () => {
  it("keeps the newest 2000 entries with increasing ids", () => {
    const log = new RingActivityLog();
    expect(ACTIVITY_CAPACITY).toBe(2000);
    for (let i = 0; i < 2005; i++) log.record({ kind: "upload", summary: `u${i}` });
    const all = log.list();
    expect(all).toHaveLength(2000);
    expect(all[0]).toMatchObject({ id: 2005, summary: "u2004" });
    expect(all.at(-1)).toMatchObject({ id: 6, summary: "u5" });
  });
  it("lists newest first, filtered by thread and kind, with a limit", () => {
    let now = 100; const log = new RingActivityLog(10, () => now++);
    log.record({ kind: "upload", threadId: "a", summary: "1", messages: 2 });
    log.record({ kind: "recall", threadId: "b", summary: "2" });
    log.record({ kind: "failure", threadId: "a", summary: "3", error: "offline" });
    expect(log.list().map(e => e.summary)).toEqual(["3", "2", "1"]);
    expect(log.list({ threadId: "a" }).map(e => e.summary)).toEqual(["3", "1"]);
    expect(log.list({ kinds: ["recall", "failure"], limit: 1 }).map(e => e.summary)).toEqual(["3"]);
    expect(log.list({ limit: 0 })).toEqual([]);
    expect(log.list()[2]).toMatchObject({ id: 1, at: 100, messages: 2 });
  });
  it("returns copies so callers cannot alter the log", () => {
    const log = new RingActivityLog(); log.record({ kind: "tool", summary: "x" });
    log.list()[0].summary = "changed"; expect(log.list()[0].summary).toBe("x");
  });
  it("notifies subscribers until they unsubscribe, and isolates listener failures", () => {
    const log = new RingActivityLog(); const seen = vi.fn();
    log.subscribe(() => { throw new Error("boom"); });
    const off = log.subscribe(seen);
    log.record({ kind: "delete", summary: "a" }); off(); log.record({ kind: "delete", summary: "b" });
    expect(seen).toHaveBeenCalledTimes(1); expect(seen.mock.calls[0][0]).toMatchObject({ id: 1, summary: "a" });
    expect(log.list()).toHaveLength(2);
  });
  it("rejects an invalid capacity", () => { expect(() => new RingActivityLog(0)).toThrow(); });
});

describe("sqlite activity log", () => {
  const host = () => createFakePluginHost({ pluginId: "honcho" });
  it("survives a plugin reload and keeps ids increasing", async () => {
    const { bb, harness } = host();
    try {
      openActivityLog(bb.storage).record({ kind: "upload", threadId: "t", summary: "saved 2 message(s)", messages: 2, redactions: 1, reasoning: true });
      await harness.lifecycle.reload(next => {
        const log = openActivityLog(next.storage);
        expect(log.list()).toEqual([{ id: 1, at: expect.any(Number), kind: "upload", threadId: "t", summary: "saved 2 message(s)", messages: 2, redactions: 1, reasoning: true }]);
        log.record({ kind: "failure", summary: "x", error: "offline" });
        expect(log.list()[0]).toMatchObject({ id: 2, error: "offline" });
      });
    } finally { await harness.lifecycle.dispose(); }
  });
  it("prunes the oldest rows beyond the cap and filters like the ring", async () => {
    const { bb, harness } = host();
    try {
      let now = 100; const log = new SqliteActivityLog(bb.storage.database(), 5, () => now++);
      for (let i = 1; i <= 8; i++) log.record({ kind: i % 2 ? "upload" : "recall", threadId: i % 2 ? "a" : "b", summary: `s${i}` });
      expect(log.list().map(e => e.summary)).toEqual(["s8", "s7", "s6", "s5", "s4"]);
      expect(log.list({ threadId: "a", limit: 2 }).map(e => e.summary)).toEqual(["s7", "s5"]);
      expect(log.list({ kinds: ["recall"] }).map(e => e.summary)).toEqual(["s8", "s6", "s4"]);
      expect(log.list({ limit: 0 })).toEqual([]);
      expect(() => new SqliteActivityLog(bb.storage.database(), 0)).toThrow();
    } finally { await harness.lifecycle.dispose(); }
  });
  it("notifies live subscribers, isolates failures, and stores no content columns", async () => {
    const { bb, harness } = host();
    try {
      const log = openActivityLog(bb.storage); const seen = vi.fn();
      log.subscribe(() => { throw new Error("boom"); }); const off = log.subscribe(seen);
      log.record({ kind: "tool", summary: "a" }); off(); log.record({ kind: "tool", summary: "b" });
      expect(seen).toHaveBeenCalledTimes(1); expect(seen.mock.calls[0][0]).toMatchObject({ id: 1, summary: "a" });
      const cols = (bb.storage.database().prepare("PRAGMA table_info(activity)").all() as Array<{ name: string }>).map(c => c.name);
      expect(cols.some(c => /content|body|text|payload/.test(c))).toBe(false);
    } finally { await harness.lifecycle.dispose(); }
  });
});

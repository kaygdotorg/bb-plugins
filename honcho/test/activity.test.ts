import { describe, expect, it, vi } from "vitest";
import { ACTIVITY_CAPACITY, RingActivityLog } from "../lib/activity";

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

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { ThreadMemoryStatus } from "../../lib/contract";
import { statusLine } from "../../ui/format";

afterEach(cleanup);

const status = (patch: Partial<ThreadMemoryStatus>): ThreadMemoryStatus => ({ threadId: "t1", state: "saving", lastUploadAt: null, queued: 0, scope: "bb", ...patch });
const props = { threadId: "t1", projectId: "p1", environment: null };

async function app() {
  return loadPluginApp(() => import("../../app"));
}

describe("registrations", () => {
  it("registers the page, card row, card section and the banner segment", async () => {
    const a = await app();
    expect(a.navPanels[0]).toMatchObject({ id: "memory", title: "Memory", icon: "Brain", path: "memory" });
    expect(typeof a.navPanels[0]!.experimental_useBadge).toBe("function");
    expect(a.threadContextCardRows).toHaveLength(1);
    expect(a.threadContextCardSections[0]).toMatchObject({ title: "memory" });
    expect(a.threadContextSegments).toHaveLength(1);
  });
});

describe("status line", () => {
  const now = 1_000_000;
  it.each([
    [{ state: "saving", lastUploadAt: now - 4000 }, 0, "memory · saving · 4s ago"],
    [{ state: "paused" }, 0, "memory · paused"],
    [{ state: "offline" }, 3, "memory · offline · 3 queued"],
    [{ state: "not-captured" }, 0, "memory · not captured"],
    [{ state: "idle" }, 0, "memory · on"],
  ] as const)("%j", (patch, queued, expected) => {
    expect(statusLine(status(patch as Partial<ThreadMemoryStatus>), queued, now)).toBe(expected);
  });
});

describe("thread context card row", () => {
  it("renders each state and toggles pause on click", async () => {
    const a = await app();
    const row = a.threadContextCardRows[0]!;
    for (const [patch, text] of [
      [{ state: "saving", lastUploadAt: Date.now() - 4000 }, /memory · saving · \d+s ago/],
      [{ state: "paused" }, /memory · paused/],
      [{ state: "offline", queued: 3 }, /memory · offline · 3 queued/],
      [{ state: "not-captured", reason: "denied by remote" }, /memory · not captured/],
    ] as const) {
      const slot = renderSlot(row, props, { rpc: { "thread.status": () => status(patch as Partial<ThreadMemoryStatus>) } });
      expect(await slot.findByText(text)).toBeTruthy();
      slot.lifecycle.unmount();
    }
    const paused = renderSlot(row, props, { rpc: { "thread.status": () => status({ state: "paused" }), "pause.set": () => ({ ok: true }) } });
    fireEvent.click(await paused.findByText(/memory · paused/));
    await waitFor(() => expect(paused.inspection.rpcCalls.some((c) => c.method === "pause.set")).toBe(true));
    expect(paused.inspection.rpcCalls.find((c) => c.method === "pause.set")!.input).toEqual({ kind: "thread", id: "t1", paused: false });
  });

  it("pauses a saving thread", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardRows[0]!, props, { rpc: { "thread.status": () => status({ state: "saving" }), "pause.set": () => ({ ok: true }) } });
    fireEvent.click(await slot.findByText(/memory · saving/));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "pause.set")?.input).toEqual({ kind: "thread", id: "t1", paused: true }));
  });

  it("does not toggle a thread that isn't captured", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardRows[0]!, props, { rpc: { "thread.status": () => status({ state: "not-captured", reason: "denied by remote" }) } });
    fireEvent.click(await slot.findByText(/not captured/));
    expect(slot.inspection.rpcCalls.some((c) => c.method === "pause.set")).toBe(false);
  });
});

describe("thread context card section", () => {
  const c = (id: string, content: string, extra = {}) => ({ id, content, observer_id: "a", observed_id: "b", created_at: "2026-01-01T00:00:00Z", agentWritten: false, confirmed: false, ...extra });
  it("lists scope and thread conclusions and links to the page", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardSections[0]!, props, {
      rpc: { "thread.context": () => ({ scope: "bb", stale: false, top: [c("1", "prefers small commits")], fromThread: [c("2", "uses vitest here", { agentWritten: true })] }) },
    });
    expect(await slot.findByText("prefers small commits")).toBeTruthy();
    expect(slot.getByText("uses vitest here")).toBeTruthy();
    expect(slot.getByText("agent")).toBeTruthy();
    fireEvent.click(slot.getByText("open memory"));
    expect(slot.inspection.navigateCalls[0]).toMatchObject({ method: "toPluginPanel", path: "memory" });
  });

  it("marks stale memory", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardSections[0]!, props, { rpc: { "thread.context": () => ({ scope: null, stale: true, top: [c("1", "old fact")], fromThread: [] }) } });
    expect(await slot.findByText(/stale/)).toBeTruthy();
  });

  it("says so when memory is offline and nothing was cached", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardSections[0]!, props, { rpc: { "thread.context": () => { throw new Error("honcho offline"); } } });
    expect(await slot.findByText(/memory is offline/)).toBeTruthy();
  });
});

describe("banner segment", () => {
  it("shows the same status", async () => {
    const a = await app();
    const reg = a.threadContextSegments[0]!;
    const slot = renderSlot({ component: reg.summary }, { ...props, segments: [], isExpanded: false, onToggle() {} }, { rpc: { "thread.status": () => status({ state: "paused" }) } });
    expect(await slot.findByText(/memory · paused/)).toBeTruthy();
  });
});

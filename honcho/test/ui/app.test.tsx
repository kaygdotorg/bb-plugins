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
    expect(a.threadInfoRows).toHaveLength(1);
    expect(a.threadContextCardRows).toHaveLength(1);
    expect(a.threadContextCardSections[0]).toMatchObject({ title: "memory" });
    expect(a.threadContextSegments).toHaveLength(1);
  });
});

describe("status line", () => {
  const now = 1_000_000;
  it.each([
    [{ state: "saving", lastUploadAt: now - 4000 }, 0, "memory · saving · saved 4s ago · group bb"],
    [{ state: "paused" }, 0, "memory · paused · group bb"],
    [{ state: "offline" }, 3, "memory · offline · 3 waiting · group bb"],
    [{ state: "not-captured" }, 0, "memory · not captured"],
    [{ state: "idle" }, 0, "memory · on · group bb"],
    [{ state: "idle", lastUploadAt: now - 120_000, scope: null }, 0, "memory · saved 2m ago"],
  ] as const)("%j", (patch, queued, expected) => {
    expect(statusLine(status(patch as Partial<ThreadMemoryStatus>), queued, now)).toBe(expected);
  });
});

describe("thread context card row", () => {
  it("renders each state and toggles pause on click", async () => {
    const a = await app();
    const row = a.threadContextCardRows[0]!;
    for (const [patch, text] of [
      [{ state: "saving", lastUploadAt: Date.now() - 4000 }, /memory · saving · saved \d+s ago/],
      [{ state: "paused" }, /memory · paused/],
      [{ state: "offline", queued: 3 }, /memory · offline · 3 waiting/],
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

describe("thread info row", () => {
  it("renders each state", async () => {
    const a = await app();
    for (const [patch, text] of [
      [{ state: "saving", lastUploadAt: Date.now() - 4000 }, /memory · saving · saved \d+s ago/],
      [{ state: "paused" }, /memory · paused/],
      [{ state: "offline", queued: 3 }, /memory · offline · 3 waiting/],
      [{ state: "not-captured", reason: "denied by remote" }, /memory · not captured/],
    ] as const) {
      const slot = renderSlot(a.threadInfoRows[0]!, props, { rpc: { "thread.status": () => status(patch as Partial<ThreadMemoryStatus>) } });
      expect(await slot.findByText(text)).toBeTruthy();
      expect(slot.getByText("Memory")).toBeTruthy();
      slot.lifecycle.unmount();
    }
  });

  it("shows a placeholder while loading and offline text on error", async () => {
    const a = await app();
    const slot = renderSlot(a.threadInfoRows[0]!, props, { rpc: { "thread.status": () => { throw new Error("down"); } } });
    expect(await slot.findByText(/memory · offline/)).toBeTruthy();
  });

  it("toggles pause both ways and opens memory", async () => {
    const a = await app();
    const saving = renderSlot(a.threadInfoRows[0]!, props, { rpc: { "thread.status": () => status({ state: "saving" }), "pause.set": () => ({ ok: true }) } });
    await saving.findByText(/memory · saving/);
    fireEvent.click(saving.getByText("pause"));
    await waitFor(() => expect(saving.inspection.rpcCalls.find((c) => c.method === "pause.set")?.input).toEqual({ kind: "thread", id: "t1", paused: true }));
    fireEvent.click(saving.getByText("open memory"));
    expect(saving.inspection.navigateCalls[0]).toMatchObject({ method: "toPluginPanel", path: "memory" });
    saving.lifecycle.unmount();
    const paused = renderSlot(a.threadInfoRows[0]!, props, { rpc: { "thread.status": () => status({ state: "paused" }), "pause.set": () => ({ ok: true }) } });
    await paused.findByText(/memory · paused/);
    fireEvent.click(paused.getByText("resume"));
    await waitFor(() => expect(paused.inspection.rpcCalls.find((c) => c.method === "pause.set")?.input).toEqual({ kind: "thread", id: "t1", paused: false }));
  });

  it("does not offer a toggle for a thread that isn't captured, and keeps open memory", async () => {
    const a = await app();
    const slot = renderSlot(a.threadInfoRows[0]!, props, { rpc: { "thread.status": () => status({ state: "not-captured" }) } });
    await slot.findByText(/not captured/);
    expect(slot.queryByText("pause")).toBeNull();
    expect(slot.queryByText("resume")).toBeNull();
    expect(slot.getByText("open memory")).toBeTruthy();
  });

  it("reads like the chip, explains the group in words, and wraps in a 390px container", async () => {
    const a = await app();
    const slot = renderSlot(a.threadInfoRows[0]!, props, { rpc: { "thread.status": () => status({ state: "saving", lastUploadAt: Date.now() - 120_000, scope: "personal" }) } });
    expect(await slot.findByText("memory · saving · saved 2m ago · group personal")).toBeTruthy();
    expect(slot.getByText(/chats from the same repo or project share memory/)).toBeTruthy();
    expect(slot.queryByText(/scope/)).toBeNull();
    const narrow = document.createElement("div");
    narrow.style.width = "390px";
    narrow.append(slot.container);
    document.body.append(narrow);
    const line = slot.getByText("memory · saving · saved 2m ago · group personal");
    expect(line.className).toContain("break-words");
    expect(line.parentElement!.className).toContain("flex-wrap");
    expect(slot.getByText("pause").className).toContain("shrink-0");
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
    expect(slot.getByText("written by an agent")).toBeTruthy();
    fireEvent.click(slot.getByText("open memory"));
    expect(slot.inspection.navigateCalls[0]).toMatchObject({ method: "toPluginPanel", path: "memory" });
  });

  it("marks stale memory", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardSections[0]!, props, { rpc: { "thread.context": () => ({ scope: null, stale: true, top: [c("1", "old fact")], fromThread: [] }) } });
    expect(await slot.findByText(/out of date/)).toBeTruthy();
  });

  it("says so when memory is offline and nothing was cached", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardSections[0]!, props, { rpc: { "thread.context": () => { throw new Error("honcho offline"); } } });
    expect(await slot.findByText(/can't be reached/)).toBeTruthy();
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

describe("banner mode (threadContextCard experiment off)", () => {
  const segmentProps = { ...props, segments: [], isExpanded: false, onToggle() {} };
  const visible = async (kind: "banner" | "card") => {
    const a = await app();
    const reg = a.threadContextSegments[0]!;
    let value: unknown = "unset";
    const Probe = () => { value = reg.useVisible!(props); return null; };
    renderSlot({ component: Probe }, {}, { threadContextKind: kind, rpc: {} });
    return value;
  };

  it("shows the segment in banner mode and leaves it to the card row in card mode", async () => {
    expect(await visible("banner")).toBe(true);
    expect(await visible("card")).toBe(false);
  });

  it("renders each state and toggles pause from the segment", async () => {
    const a = await app();
    const reg = a.threadContextSegments[0]!;
    const rpc = { "thread.status": () => status({ state: "saving", lastUploadAt: Date.now() - 4000 }), "pause.set": () => ({ ok: true }) };
    const slot = renderSlot({ component: reg.summary }, segmentProps, { rpc });
    fireEvent.click(await slot.findByText(/memory · saving · saved \d+s ago/));
    await waitFor(() => expect(slot.inspection.rpcCalls.find((c) => c.method === "pause.set")?.input).toEqual({ kind: "thread", id: "t1", paused: true }));
    slot.lifecycle.unmount();

    const paused = renderSlot({ component: reg.summary }, segmentProps, { rpc: { "thread.status": () => status({ state: "paused" }), "pause.set": () => ({ ok: true }) } });
    fireEvent.click(await paused.findByText("memory · paused · group bb"));
    await waitFor(() => expect(paused.inspection.rpcCalls.find((c) => c.method === "pause.set")?.input).toEqual({ kind: "thread", id: "t1", paused: false }));
    paused.lifecycle.unmount();

    const off = renderSlot({ component: reg.summary }, segmentProps, { rpc: { "thread.status": () => status({ state: "not-captured", reason: "denied by remote" }) } });
    const button = (await off.findByText("memory · not captured")).closest("button")!;
    expect(button.disabled).toBe(true);
  });

  it("is on screen before the first answer, and when the answer fails", async () => {
    const a = await app();
    const reg = a.threadContextSegments[0]!;
    const waiting = renderSlot({ component: reg.summary }, segmentProps, { rpc: { "thread.status": () => new Promise(() => {}) } });
    expect(waiting.getByText("memory · checking")).toBeTruthy();
    waiting.lifecycle.unmount();
    const failing = renderSlot({ component: reg.summary }, segmentProps, { rpc: { "thread.status": () => { throw new Error("down"); } } });
    expect(await failing.findByText("memory · offline")).toBeTruthy();
  });

  it("the card row is on screen before the first answer too", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardRows[0]!, props, { rpc: { "thread.status": () => new Promise(() => {}) } });
    expect(slot.getByText("memory · checking")).toBeTruthy();
  });
});

describe("conclusion origin", () => {
  const c = (id: string, extra = {}) => ({ id, content: `fact ${id}`, observer_id: "a", observed_id: "b", created_at: "2026-01-01T00:00:00Z", agentWritten: false, confirmed: false, ...extra });
  it("shows learned, falls back to agentWritten without origin, and hides the badge once confirmed", async () => {
    const a = await app();
    const slot = renderSlot(a.threadContextCardSections[0]!, props, {
      rpc: { "thread.context": () => ({ scope: "bb", stale: false, top: [c("1", { origin: "learned" }), c("2", { agentWritten: true }), c("3", { origin: "confirmed", confirmed: true })], fromThread: [] }) },
    });
    expect(await slot.findByText("learned")).toBeTruthy();
    expect(slot.getByText("written by an agent")).toBeTruthy();
    expect(slot.queryByText("confirmed")).toBeNull();
  });
});

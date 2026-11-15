// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { HarnessState } from "../../lib/contract";

afterEach(cleanup);

const harness = (patch: Partial<HarnessState> = {}): HarnessState => ({
  machineId: "dev", claude: { hookInstalled: false, handedOver: false, pluginVersion: null }, codex: { hookInstalled: false, handedOver: false, trusted: null }, backups: [], ...patch,
});
const health = { oldestPendingAt: null, queued: 0, authFailing: false, tripwire: null };

async function page(subPath: string, rpc: Record<string, (input: any) => unknown>) {
  const a = await loadPluginApp(() => import("../../app"));
  return renderSlot(a.navPanels[0]!, { subPath }, { rpc: rpc as never });
}
const calls = (slot: Awaited<ReturnType<typeof page>>, method: string) => slot.inspection.rpcCalls.filter((c) => c.method === method);

describe("tabs", () => {
  it("opens another tab through the panel route", async () => {
    const slot = await page("", { "activity.list": () => [] });
    fireEvent.click(slot.getByRole("tab", { name: "privacy" }));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "memory" });
  });
});

describe("activity", () => {
  it("shows empty, then rows with counts, flags and a thread link", async () => {
    const empty = await page("activity", { "activity.list": () => [] });
    expect(await empty.findByText("nothing yet")).toBeTruthy();
    empty.lifecycle.unmount();
    const slot = await page("activity", {
      "activity.list": () => [
        { id: 2, at: Date.now(), kind: "upload", threadId: "t9", summary: "uploaded a batch", messages: 4, redactions: 2, reasoning: true },
        { id: 1, at: Date.now(), kind: "failure", summary: "upload failed", error: "offline" },
      ],
    });
    expect(await slot.findByText("uploaded a batch")).toBeTruthy();
    expect(slot.getByText("4 messages · 2 redacted")).toBeTruthy();
    expect(slot.getByText("reasoning")).toBeTruthy();
    fireEvent.click(slot.getByLabelText("open thread"));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "t9" });
  });

  it("shows an offline state when nothing could be loaded", async () => {
    const slot = await page("activity", { "activity.list": () => { throw new Error("nope"); } });
    expect(await slot.findByRole("alert")).toBeTruthy();
  });
});

describe("conclusions", () => {
  const c = (id: string, extra = {}) => ({ id, content: `fact ${id}`, observer_id: "a", observed_id: "b", created_at: "2026-01-01T00:00:00Z", agentWritten: false, confirmed: false, ...extra });
  it("searches, confirms and deletes after a second click", async () => {
    const slot = await page("conclusions", { "conclusions.list": () => [c("1", { agentWritten: true })], "conclusions.confirm": () => ({ ok: true }), "conclusions.delete": () => ({ ok: true }) });
    expect(await slot.findByText("agent-written")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("search conclusions"), { target: { value: "vitest" } });
    fireEvent.submit(slot.getByRole("search"));
    await waitFor(() => expect(calls(slot, "conclusions.list").some((x) => (x.input as any).query === "vitest")).toBe(true));
    fireEvent.click(slot.getByText("confirm"));
    await waitFor(() => expect(calls(slot, "conclusions.confirm")[0]!.input).toEqual({ id: "1" }));
    fireEvent.click(slot.getByText("delete"));
    expect(calls(slot, "conclusions.delete")).toHaveLength(0);
    fireEvent.click(slot.getByText("delete for good"));
    await waitFor(() => expect(calls(slot, "conclusions.delete")[0]!.input).toEqual({ id: "1" }));
  });
});

describe("peers", () => {
  it("renames and explains what a rename does", async () => {
    const slot = await page("peers", { "peers.list": () => [{ providerId: "codex", peer: "codex", firstSeen: null }], "peers.rename": () => ({ ok: true }) });
    expect(await slot.findByText(/starts a new peer from now on/)).toBeTruthy();
    fireEvent.click(await slot.findByText("rename"));
    fireEvent.change(slot.getByLabelText("peer for codex"), { target: { value: "codex_two" } });
    fireEvent.click(slot.getByText("save"));
    await waitFor(() => expect(calls(slot, "peers.rename")[0]!.input).toEqual({ providerId: "codex", peer: "codex_two" }));
  });
});

describe("privacy", () => {
  const settings = { denyRemotes: [], denyPaths: [], patterns: [], deleteOnDelete: true, purgeConclusionsOnDelete: true };
  it("tests text and shows the redacted output with its count", async () => {
    const slot = await page("privacy", {
      "pause.list": () => [], "privacy.get": () => settings,
      "privacy.test": ({ text }: { text: string }) => ({ text: text.replace("hunter2", "[REDACTED]"), count: 1 }),
    });
    fireEvent.change(await slot.findByLabelText("text to test"), { target: { value: "pw hunter2" } });
    fireEvent.click(slot.getByText("test"));
    expect((await slot.findByLabelText("redacted output")).textContent).toBe("pw [REDACTED]");
    expect(slot.getByText("1 redacted")).toBeTruthy();
    expect(calls(slot, "privacy.test")[0]!.input).toEqual({ text: "pw hunter2" });
  });

  it("lists pauses with unpause, and flips the delete toggles with the agreed copy", async () => {
    const slot = await page("privacy", {
      "pause.list": () => [{ kind: "project", id: "proj_1", since: Date.now() }], "pause.set": () => ({ ok: true }),
      "privacy.get": () => settings, "privacy.set": () => settings,
    });
    fireEvent.click(await slot.findByText("unpause"));
    await waitFor(() => expect(calls(slot, "pause.set")[0]!.input).toEqual({ kind: "project", id: "proj_1", paused: false }));
    expect(slot.getByText("deletes the transcript; the peer card may still reflect it until it regenerates.")).toBeTruthy();
    fireEvent.click(slot.getByRole("switch", { name: "delete its transcript from honcho" }));
    await waitFor(() => expect(calls(slot, "privacy.set")[0]!.input).toEqual({ deleteOnDelete: false }));
  });

  it("saves rules one entry per line", async () => {
    const slot = await page("privacy", { "pause.list": () => [], "privacy.get": () => settings, "privacy.set": () => settings });
    fireEvent.change(await slot.findByLabelText("deny paths"), { target: { value: "/work/a/**\n\n/work/b/**" } });
    fireEvent.click(slot.getByText("save"));
    await waitFor(() => expect(calls(slot, "privacy.set")[0]!.input).toMatchObject({ denyPaths: ["/work/a/**", "/work/b/**"] }));
  });
});

describe("connection", () => {
  const conn = { preset: "self-hosted", baseUrl: "https://honcho.example.org", workspace: "hermes", peerName: "hermy", keySource: "config-file", keyLevel: "workspace-or-admin", warnings: ["bb workspace overrides the Honcho file setting."] };
  const base = {
    "connection.get": () => conn, health: () => health, "harness.state": () => harness(), "backfill.progress": () => ({ running: false, done: 0, total: 0 }),
  };

  it("shows the connection without a key and tests it", async () => {
    const slot = await page("connection", { ...base, "connection.test": () => ({ ok: true, latencyMs: 42 }) });
    expect(await slot.findByText("https://honcho.example.org")).toBeTruthy();
    expect(slot.getByText(/workspace or admin/)).toBeTruthy();
    expect(slot.getByText(/overrides the Honcho file setting/)).toBeTruthy();
    fireEvent.click(slot.getByText("test connection"));
    expect(await slot.findByText("connected · 42 ms")).toBeTruthy();
  });

  it("connect harnesses, hand over and undo call their own rpcs", async () => {
    const installed = harness({ claude: { hookInstalled: true, handedOver: true, pluginVersion: null } });
    let current = harness();
    const slot = await page("connection", {
      ...base, "harness.state": () => current,
      "harness.connect": () => (current = installed), "harness.handOver": () => (current = installed), "harness.undo": () => current,
    });
    fireEvent.click(await slot.findByText("connect harnesses", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "harness.connect")).toHaveLength(1));
    fireEvent.click(slot.getByText("hand over to bb", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "harness.handOver")).toHaveLength(1));
    expect(calls(slot, "harness.undo")).toHaveLength(0);
    fireEvent.click(await slot.findByLabelText("undo hand over"));
    await waitFor(() => expect(calls(slot, "harness.undo")).toHaveLength(1));
    fireEvent.click(await slot.findByLabelText("undo connect"));
    await waitFor(() => expect(calls(slot, "harness.undo")).toHaveLength(2));
    expect(calls(slot, "harness.undo").map((c) => c.input)).toEqual([{ step: "handOver" }, { step: "connect" }]);
  });

  it("dry-runs the backfill before it can start, then shows progress", async () => {
    let running = false;
    const slot = await page("connection", {
      ...base,
      "backfill.progress": () => (running ? { running: true, done: 5, total: 20 } : { running: false, done: 0, total: 0 }),
      "backfill.dryRun": () => ({ threads: 3, messages: 20, tokens: 900, skippedAlreadyInHoncho: 1, reasoningMessages: 2 }),
      "backfill.start": () => { running = true; return { ok: true }; }, "backfill.stop": () => ({ ok: true }),
    });
    const start = await slot.findByText("start", { selector: "button" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByText("dry run"));
    const summary = await slot.findByLabelText("dry run");
    expect(within(summary).getByText("20")).toBeTruthy();
    fireEvent.click(slot.getByText("start", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "backfill.start")).toHaveLength(1));
    expect(await slot.findByRole("progressbar")).toBeTruthy();
    expect(await slot.findByText("stop")).toBeTruthy();
  });
});

describe("badge", () => {
  async function badge(h: object) {
    const a = await loadPluginApp(() => import("../../app"));
    const hook = a.navPanels[0]!.experimental_useBadge!;
    let value: unknown = "unset";
    const Probe = () => { value = hook(); return null; };
    const slot = renderSlot({ component: Probe }, {}, { rpc: { health: () => ({ ...health, ...h }) } as never });
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 0));
    return () => value;
  }
  it("is quiet when healthy and for fresh pending items", async () => {
    expect((await badge({ queued: 2, oldestPendingAt: Date.now() - 30_000 }))()).toBeNull();
  });
  it("shows on auth failure, tripwire, and an item older than 10 minutes", async () => {
    expect((await badge({ authFailing: true }))()).toMatchObject({ tone: "critical" });
    expect((await badge({ tripwire: "claude-honcho session found" }))()).toMatchObject({ tone: "critical" });
    expect((await badge({ queued: 3, oldestPendingAt: Date.now() - 11 * 60_000 }))()).toMatchObject({ tone: "warning", count: 3 });
  });
});

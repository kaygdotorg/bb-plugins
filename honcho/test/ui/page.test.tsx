// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
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
      "labels.get": () => ({ threads: { t9: "Fix the login bug" }, projects: {} }),
      "activity.list": () => [
        { id: 2, at: Date.now(), kind: "upload", threadId: "t9", summary: "uploaded a batch", messages: 4, redactions: 2, reasoning: true },
        { id: 1, at: Date.now(), kind: "failure", summary: "upload failed", error: "offline" },
      ],
    });
    expect(await slot.findByText("uploaded a batch")).toBeTruthy();
    expect(slot.getByText("4 messages · 2 hidden")).toBeTruthy();
    expect(slot.getByText("with thinking")).toBeTruthy();
    fireEvent.click(await slot.findByLabelText("open chat Fix the login bug"));
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
    expect(await slot.findByText("written by an agent")).toBeTruthy();
    fireEvent.change(slot.getByLabelText("search what memory has learned"), { target: { value: "vitest" } });
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

describe("conclusions search", () => {
  const c = (id: string, content: string) => ({ id, content, observer_id: "a", observed_id: "b", created_at: "2026-01-01T00:00:00Z", agentWritten: false, confirmed: false });
  const texts = (slot: Awaited<ReturnType<typeof page>>) => within(slot.getByLabelText("things memory has learned")).getAllByRole("listitem").map((li) => li.querySelector("p")!.textContent);

  it("puts exact matches first and says how many matched, never 50", async () => {
    const slot = await page("conclusions", { "conclusions.list": (i: { query?: string }) => i.query ? [c("1", "unrelated health fact"), c("2", "Works with a TESTER"), c("3", "other")] : [c("9", "x")] });
    fireEvent.change(slot.getByLabelText("search what memory has learned"), { target: { value: "tester" } });
    fireEvent.submit(slot.getByRole("search"));
    expect(await slot.findByText(/1 thing matches "tester", plus 2 related/)).toBeTruthy();
    expect(texts(slot)[0]).toBe("Works with a TESTER");
    expect(slot.queryByText(/50/)).toBeNull();
  });

  it("says so when nothing matches exactly", async () => {
    const slot = await page("conclusions", { "conclusions.list": (i: { query?: string }) => i.query ? [c("1", "close idea")] : [] });
    fireEvent.change(slot.getByLabelText("search what memory has learned"), { target: { value: "rita" } });
    fireEvent.submit(slot.getByRole("search"));
    expect(await slot.findByText(/nothing says "rita" exactly. 1 related thing/)).toBeTruthy();
  });

  it("a new query replaces the old one: focus selects the text, and clear empties it", async () => {
    const slot = await page("conclusions", { "conclusions.list": () => [c("1", "a")] });
    const box = (await slot.findByLabelText("search what memory has learned")) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "FAKE" } });
    fireEvent.submit(slot.getByRole("search"));
    fireEvent.focus(box);
    expect([box.selectionStart, box.selectionEnd]).toEqual([0, 4]);
    fireEvent.click(slot.getByLabelText("clear the search"));
    expect(box.value).toBe("");
    await waitFor(() => expect(calls(slot, "conclusions.list").at(-1)!.input).toEqual({ limit: 50 }));
  });
});

describe("plain words", () => {
  it("maps legacy activity summaries and drops jargon from privacy and connection", async () => {
    const slot = await page("activity", { "activity.list": () => [
      { id: 1, at: Date.now(), kind: "harness", summary: "session rebuilt with the harness capture off at seq 11; capture will cover seq 12 on, once the old honcho plugin is seen quiet" },
      { id: 2, at: Date.now(), kind: "recall", summary: "per-turn memory: 5 excerpts" },
      { id: 3, at: Date.now(), kind: "recall", summary: "session memory injected (scope personal)" },
    ] });
    expect(await slot.findByText("looked up 5 memories for a message")).toBeTruthy();
    expect(slot.getByText("gave the assistant memory for group personal")).toBeTruthy();
    expect(slot.queryByText(/seq|harness|scope/)).toBeNull();
    expect(slot.getByText("show problems only")).toBeTruthy();
    slot.lifecycle.unmount();
    const privacy = await page("privacy", { "privacy.get": () => ({ denyRemotes: [], denyPaths: [], patterns: [] }), "pause.list": () => [] });
    expect(await privacy.findByText(/patterns \(advanced\)/)).toBeTruthy();
    expect(privacy.queryByText(/regular expressions|git address/)).toBeNull();
  });
});

describe("peers", () => {
  it("renames and explains what a rename does", async () => {
    const slot = await page("peers", { "peers.list": () => [{ providerId: "codex", peer: "codex", firstSeen: null }], "peers.rename": () => ({ ok: true }) });
    expect(await slot.findByText(/starts a new name from now on/)).toBeTruthy();
    fireEvent.click(await slot.findByText("rename"));
    fireEvent.change(slot.getByLabelText("name for codex"), { target: { value: "codex_two" } });
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
    fireEvent.change(await slot.findByLabelText("text to try"), { target: { value: "pw hunter2" } });
    fireEvent.click(slot.getByText("try it"));
    expect((await slot.findByLabelText("text after hiding")).textContent).toBe("pw [REDACTED]");
    expect(slot.getByText("1 would be hidden")).toBeTruthy();
    expect(calls(slot, "privacy.test")[0]!.input).toEqual({ text: "pw hunter2" });
  });

  it("lists pauses with unpause, and flips the delete toggles with the agreed copy", async () => {
    const slot = await page("privacy", {
      "pause.list": () => [{ kind: "project", id: "proj_1", since: Date.now() }], "pause.set": () => ({ ok: true }),
      "privacy.get": () => settings, "privacy.set": () => settings,
    });
    fireEvent.click(await slot.findByText("resume"));
    await waitFor(() => expect(calls(slot, "pause.set")[0]!.input).toEqual({ kind: "project", id: "proj_1", paused: false }));
    expect(slot.getByText(/removes the saved conversation/)).toBeTruthy();
    fireEvent.click(slot.getByRole("switch", { name: "also delete its saved copy from memory" }));
    await waitFor(() => expect(calls(slot, "privacy.set")[0]!.input).toEqual({ deleteOnDelete: false }));
  });

  it("saves rules one entry per line", async () => {
    const slot = await page("privacy", { "pause.list": () => [], "privacy.get": () => settings, "privacy.set": () => settings });
    fireEvent.change(await slot.findByLabelText("skip these folders"), { target: { value: "/work/a/**\n\n/work/b/**" } });
    fireEvent.click(slot.getByText("save"));
    await waitFor(() => expect(calls(slot, "privacy.set")[0]!.input).toMatchObject({ denyPaths: ["/work/a/**", "/work/b/**"] }));
  });
});

describe("privacy edits", () => {
  const settings = { denyRemotes: [], denyPaths: [], patterns: [], deleteOnDelete: true, purgeConclusionsOnDelete: true };
  it("keeps typed text across refetches that return an unchanged value, and adopts a changed stored value when clean", async () => {
    let stored: { denyRemotes: string[]; denyPaths: string[]; patterns: string[]; deleteOnDelete: boolean; purgeConclusionsOnDelete: boolean } = { ...settings, denyRemotes: [], denyPaths: [], patterns: [] };
    const slot = await page("privacy", { "pause.list": () => [], "privacy.get": () => JSON.parse(JSON.stringify(stored)), "privacy.set": () => stored });
    const box = await slot.findByLabelText("skip these folders") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "/work/typing" } });
    await slot.emitRealtime("changed", { what: "peers" });
    await waitFor(() => expect(calls(slot, "privacy.get").length).toBeGreaterThan(1));
    expect(box.value).toBe("/work/typing");
    // A different stored value never overwrites a dirty field.
    stored = { ...settings, denyPaths: ["/elsewhere"] };
    const before = calls(slot, "privacy.get").length;
    await slot.emitRealtime("changed", { what: "privacy" });
    await waitFor(() => expect(calls(slot, "privacy.get").length).toBeGreaterThan(before));
    expect(box.value).toBe("/work/typing");
    // Clean fields follow the stored value.
    fireEvent.change(box, { target: { value: "/elsewhere" } });
    stored = { ...settings, denyPaths: ["/later"] };
    await slot.emitRealtime("changed", { what: "privacy" });
    await waitFor(() => expect(box.value).toBe("/later"));
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
    expect(slot.getByText(/can use everything/)).toBeTruthy();
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
    fireEvent.click(await slot.findByText("turn on", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "harness.connect")).toHaveLength(1));
    fireEvent.click(slot.getByText("turn them off", { selector: "button" }));
    await waitFor(() => expect(calls(slot, "harness.handOver")).toHaveLength(1));
    expect(calls(slot, "harness.undo")).toHaveLength(0);
    fireEvent.click(await slot.findByLabelText("undo turning off the old plugins"));
    await waitFor(() => expect(calls(slot, "harness.undo")).toHaveLength(1));
    fireEvent.click(await slot.findByLabelText("undo turning on memory"));
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
    const start = await slot.findByText("import", { selector: "button" });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(slot.getByText("check first"));
    const summary = await slot.findByLabelText("what an import would do");
    expect(within(summary).getByText("20")).toBeTruthy();
    fireEvent.click(slot.getByText("import", { selector: "button" }));
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

describe("privacy typing, saving and errors", () => {
  const settings = { denyRemotes: [], denyPaths: [], patterns: [], deleteOnDelete: true, purgeConclusionsOnDelete: true };
  const base = { "pause.list": () => [], "privacy.get": () => settings };

  it("typing makes no rpc call; only save does, and the test box only runs on its button", async () => {
    const slot = await page("privacy", { ...base, "privacy.set": () => ({ ...settings, patterns: ["a+"] }), "privacy.test": () => ({ text: "x", count: 0 }) });
    const rules = await slot.findByLabelText("hide text matching");
    const tryBox = slot.getByLabelText("text to try");
    await waitFor(() => expect(calls(slot, "privacy.get").length).toBeGreaterThan(0));
    const before = slot.inspection.rpcCalls.length;
    for (let i = 1; i <= 60; i++) {
      fireEvent.change(rules, { target: { value: "a".repeat(i) } });
      fireEvent.change(tryBox, { target: { value: "b".repeat(i) } });
    }
    expect(slot.inspection.rpcCalls.length).toBe(before);
    expect(calls(slot, "privacy.set")).toHaveLength(0);
    expect(calls(slot, "privacy.test")).toHaveLength(0);
    fireEvent.click(slot.getByText("save"));
    await waitFor(() => expect(calls(slot, "privacy.set")).toHaveLength(1));
    expect(calls(slot, "privacy.test")).toHaveLength(0);
  });

  it("says unsaved while dirty, then saved, and never unsaved again after a successful save", async () => {
    let stored = { ...settings };
    const slot = await page("privacy", {
      "pause.list": () => [], "privacy.get": () => stored,
      // the server tidies: trims and drops duplicates
      "privacy.set": (input: any) => (stored = { ...stored, ...input, denyPaths: [...new Set<string>(input.denyPaths)] }),
    });
    const box = await slot.findByLabelText("skip these folders") as HTMLTextAreaElement;
    expect(slot.queryByText("unsaved changes")).toBeNull();
    fireEvent.change(box, { target: { value: "/a/**\n/a/**\n\n" } });
    expect(slot.getByText("unsaved changes")).toBeTruthy();
    fireEvent.click(slot.getByText("save"));
    expect(await slot.findByText("saved")).toBeTruthy();
    await slot.emitRealtime("changed", { what: "privacy" });
    await waitFor(() => expect(calls(slot, "privacy.get").length).toBeGreaterThan(1));
    expect(slot.queryByText("unsaved changes")).toBeNull();
    expect((slot.getByText("save") as HTMLButtonElement).disabled).toBe(true);
    expect(box.value).toBe("/a/**");
    // editing again flips it back
    fireEvent.change(box, { target: { value: "/b/**" } });
    expect(slot.getByText("unsaved changes")).toBeTruthy();
  });

  it("shows a server error next to its line and keeps the text", async () => {
    const slot = await page("privacy", {
      ...base,
      "privacy.set": () => { throw new experimental_PluginRpcRefusal({ code: "invalid", message: "Not saved.", issues: [{ message: "this is not a valid pattern", path: ["patterns", 1] }] }); },
    });
    const box = await slot.findByLabelText("hide text matching") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "ok+\n\nbad[(" } });
    fireEvent.click(slot.getByText("save"));
    const problem = await slot.findByText(/this is not a valid pattern/);
    expect(problem.closest("li")!.textContent).toContain("line 3");
    expect(problem.closest("li")!.textContent).toContain("bad[(");
    expect(box.value).toBe("ok+\n\nbad[(");
    expect(box.getAttribute("aria-invalid")).toBe("true");
    expect(slot.getByText("one entry needs fixing")).toBeTruthy();
    // fixing the line clears its problem
    fireEvent.change(box, { target: { value: "ok+\n\nfine" } });
    expect(slot.queryByText(/this is not a valid pattern/)).toBeNull();
  });
});

describe("chat titles instead of ids", () => {
  it("shows the title of a paused chat and of a project, and links the chat", async () => {
    const slot = await page("privacy", {
      "pause.list": () => [{ kind: "thread", id: "thr_abc", since: Date.now() }, { kind: "project", id: "proj_1", since: Date.now() }],
      "privacy.get": () => ({ denyRemotes: [], denyPaths: [], patterns: [], deleteOnDelete: true, purgeConclusionsOnDelete: true }),
      "labels.get": () => ({ threads: { thr_abc: "Plan the migration" }, projects: { proj_1: "bb plugins" } }),
    });
    fireEvent.click(await slot.findByText("Plan the migration"));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "thr_abc" });
    expect(await slot.findByText("bb plugins")).toBeTruthy();
    expect(slot.queryByText("thr_abc")).toBeNull();
  });

  it("never shows a raw id when the title is unknown", async () => {
    const slot = await page("activity", { "activity.list": () => [{ id: 1, at: Date.now(), kind: "upload", threadId: "thr_zzz", summary: "saved" }], "labels.get": () => ({ threads: { thr_zzz: null }, projects: {} }) });
    expect(await slot.findByText("untitled chat")).toBeTruthy();
    expect(slot.container.textContent).not.toContain("thr_zzz");
  });
});

describe("conclusions: plain words", () => {
  const c = (id: string, extra = {}) => ({ id, content: `fact ${id}`, observer_id: "a", observed_id: "b", created_at: "2026-01-01T00:00:00Z", agentWritten: false, confirmed: false, ...extra });
  it("labels by origin, explains confirm, and falls back to agentWritten", async () => {
    const slot = await page("conclusions", { "conclusions.list": () => [c("1", { origin: "learned" }), c("2", { agentWritten: true }), c("3", { origin: "confirmed", confirmed: true })] });
    expect(await slot.findByText("learned")).toBeTruthy();
    expect(slot.getByText("written by an agent")).toBeTruthy();
    expect(slot.getByText("confirmed")).toBeTruthy();
    expect(slot.getByText(/confirm means "this is right"/)).toBeTruthy();
    expect(slot.getAllByText("confirm")).toHaveLength(2);
  });
});

describe("import numbers say what will happen", () => {
  it("labels each dry-run figure", async () => {
    const slot = await page("connection", {
      "connection.get": () => ({ preset: "cloud", baseUrl: "https://x", workspace: "w", peerName: "p", keySource: "none", keyLevel: "unknown", warnings: [] }),
      health: () => health, "harness.state": () => harness(), "backfill.progress": () => ({ running: false, done: 0, total: 0 }),
      "backfill.dryRun": () => ({ threads: 3, messages: 20, tokens: 900, skippedAlreadyInHoncho: 1, reasoningMessages: 2 }),
    });
    fireEvent.click(await slot.findByText("check first"));
    const list = await slot.findByLabelText("what an import would do");
    for (const label of ["chats it will save", "messages it will save", "already saved, skipped"]) expect(within(list).getByText(label)).toBeTruthy();
  });
});

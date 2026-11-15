import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { registerCli, ago, formatPlan } from "../../lib/cli";
import type { BackfillService, CaptureService, HarnessService, HarnessState } from "../../lib/contract";

const state: HarnessState = { machineId: "m1", claude: { hookInstalled: true, handedOver: false, pluginVersion: "0.4.0" }, codex: { hookInstalled: false, handedOver: false, trusted: null }, backups: [] };
function setup() {
  const plan = { threads: 3, messages: 40, tokens: 900, skippedAlreadyInHoncho: 7, reasoningMessages: 12 };
  const capture = {
    health: vi.fn(async () => ({ oldestPendingAt: null, queued: 2, authFailing: false, tripwire: null })),
    threadStatus: vi.fn(async (threadId: string) => ({ threadId, state: "saving" as const, lastUploadAt: Date.now() - 4000, queued: 0, scope: "repo" })),
    setPaused: vi.fn(async () => {}),
  } as unknown as CaptureService & Record<string, ReturnType<typeof vi.fn>>;
  const backfill = {
    dryRun: vi.fn(async () => plan), start: vi.fn(async () => {}), stop: vi.fn(async () => {}),
    progress: vi.fn(async () => ({ running: true, done: 5, total: 20 })),
  } as unknown as BackfillService & Record<string, ReturnType<typeof vi.fn>>;
  const harness = { state: vi.fn(async () => state), connect: vi.fn(async () => state), handOver: vi.fn(async () => ({ ...state, claude: { ...state.claude, handedOver: true } })), undo: vi.fn(async () => state) } as unknown as HarnessService & Record<string, ReturnType<typeof vi.fn>>;
  const host = createFakePluginHost({ pluginId: "honcho" });
  registerCli(host.bb, { capture, backfill, harness });
  return { host, capture, backfill, hs: harness, run: (argv: string[], ctx = {}) => host.harness.runCli(argv, ctx) };
}
let current: ReturnType<typeof setup> | undefined;
afterEach(async () => { await current?.host.harness.lifecycle.dispose(); current = undefined; });
const use = () => (current = setup());

describe("bb honcho CLI", () => {
  it("registers one `honcho` command and renders help with exit 0", async () => {
    const t = use();
    expect(t.host.harness.registrations.cli?.name).toBe("honcho");
    const help = await t.run(["--help"]); expect(help.exitCode).toBe(0);
    for (const word of ["status", "pause", "backfill", "harness state", "harness hand-over"]) expect(help.stdout).toContain(word);
  });
  it("status: health only without a thread, plus the thread when ctx.threadId is set", async () => {
    const t = use();
    const bare = await t.run(["status"]);
    expect(bare.stdout).toContain("honcho: ok"); expect(bare.stdout).toContain("queued: 2"); expect(bare.stdout).not.toContain("thread ");
    const inThread = await t.run(["status"], { threadId: "thr_1" });
    expect(inThread.stdout).toContain("thread thr_1: saving"); expect(inThread.stdout).toContain("scope: repo");
    const asJson = JSON.parse((await t.run(["status", "--json"], { threadId: "thr_1" })).stdout);
    expect(asJson).toMatchObject({ health: { queued: 2 }, thread: { threadId: "thr_1", state: "saving" } });
  });
  it("pause defaults to the current thread, --project to the project, --off resumes", async () => {
    const t = use();
    expect((await t.run(["pause"], { threadId: "thr_1", projectId: "proj_1" })).stdout).toContain("paused for thread thr_1");
    expect(t.capture.setPaused).toHaveBeenLastCalledWith({ kind: "thread", id: "thr_1" }, true);
    await t.run(["pause", "--project", "--off"], { threadId: "thr_1", projectId: "proj_1" });
    expect(t.capture.setPaused).toHaveBeenLastCalledWith({ kind: "project", id: "proj_1" }, false);
  });
  it("pause without a thread or project fails with a hint", async () => {
    const t = use();
    const result = await t.run(["pause"]);
    expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain("no current thread");
    const asJson = JSON.parse((await t.run(["pause", "--json"])).stdout);
    expect(asJson).toMatchObject({ ok: false, error: { code: "missing_thread" } });
  });
  it("backfill --dry-run prints the plan, with filters passed through, and --json", async () => {
    const t = use();
    const text = (await t.run(["backfill", "--dry-run", "--project", "proj_9", "--since", "2026-01-31"])).stdout;
    expect(text).toContain("nothing was written"); expect(text).toContain("threads:                3"); expect(text).toContain("already in honcho:      7");
    expect(t.backfill.dryRun).toHaveBeenCalledWith({ projectId: "proj_9", since: "2026-01-31T00:00:00.000Z" });
    expect(JSON.parse((await t.run(["backfill", "--dry-run", "--json"])).stdout)).toEqual({ threads: 3, messages: 40, tokens: 900, skippedAlreadyInHoncho: 7, reasoningMessages: 12 });
    expect(t.backfill.dryRun).toHaveBeenLastCalledWith({});
  });
  it("backfill --start / --stop / --progress", async () => {
    const t = use();
    expect((await t.run(["backfill", "--start"])).stdout).toContain("backfill started"); expect(t.backfill.start).toHaveBeenCalledTimes(1);
    expect((await t.run(["backfill", "--stop"])).stdout).toContain("stopped"); expect(t.backfill.stop).toHaveBeenCalledTimes(1);
    expect((await t.run(["backfill", "--progress"])).stdout).toContain("backfill running: 5/20 messages (25%)");
    expect(JSON.parse((await t.run(["backfill", "--progress", "--json"])).stdout)).toEqual({ running: true, done: 5, total: 20 });
  });
  it("backfill needs exactly one mode and a valid date", async () => {
    const t = use();
    expect((await t.run(["backfill"])).exitCode).not.toBe(0);
    expect((await t.run(["backfill", "--start", "--stop"])).exitCode).not.toBe(0);
    const bad = await t.run(["backfill", "--dry-run", "--since", "not-a-date"]);
    expect(bad.exitCode).not.toBe(0); expect(bad.stderr).toContain("invalid --since");
    expect(t.backfill.dryRun).not.toHaveBeenCalled();
  });
  it("rejects unknown options with a suggestion", async () => {
    const result = await use().run(["backfill", "--dryrun"]);
    expect(result.exitCode).not.toBe(0); expect(result.stderr).toContain("unknown option");
  });
  it("harness subcommands call the matching service method and print the state", async () => {
    const t = use();
    expect((await t.run(["harness", "state"])).stdout).toContain("claude: hook installed, claude-honcho active (0.4.0)");
    expect((await t.run(["harness", "hand-over", "--machine", "m2"])).stdout).toContain("handed over");
    expect(t.hs.handOver).toHaveBeenCalledWith("m2");
    await t.run(["harness", "connect"]); await t.run(["harness", "undo", "--json"]);
    expect(t.hs.connect).toHaveBeenCalledWith(undefined); expect(t.hs.undo).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await t.run(["harness", "state", "--json"])).stdout)).toMatchObject({ machineId: "m1", codex: { trusted: null } });
  });
  it("harness undo --step undoes one step, and refuses anything else", async () => {
    const t = use();
    await t.run(["harness", "undo"]);
    expect((await t.run(["harness", "undo", "--step", "connect"])).exitCode).toBe(0);
    expect((await t.run(["harness", "undo", "--step", "hand-over", "--machine", "m2"])).exitCode).toBe(0);
    expect(vi.mocked(t.hs.undo).mock.calls).toEqual([[undefined, undefined], [undefined, "connect"], ["m2", "handOver"]]);
    const bad = await t.run(["harness", "undo", "--step", "everything"]);
    expect(bad.exitCode).not.toBe(0);
    expect(t.hs.undo).toHaveBeenCalledTimes(3);
  });
  it("formats helpers", () => {
    expect(ago(null)).toBe("never"); expect(ago(1000, 5000)).toBe("4s ago"); expect(ago(0, 7_200_000)).toBe("2h ago");
    expect(formatPlan({ threads: 1, messages: 2, tokens: 3, skippedAlreadyInHoncho: 4, reasoningMessages: 5 })).toContain("tokens (about):         3");
  });
});

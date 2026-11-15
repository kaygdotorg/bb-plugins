import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import type { BackfillPlan, BackfillService, CaptureService, HarnessService, HarnessState } from "./contract";

export interface CliServices { capture: CaptureService; backfill: BackfillService; harness: HarnessService }

const json = { type: "boolean", description: "Emit machine-readable JSON" } as const;
const out = (value: unknown, human: string, asJson: boolean): PluginCliResult => ({ exitCode: 0, stdout: (asJson ? JSON.stringify(value, null, 2) : human) + "\n" });

export function ago(at: number | null | undefined, now = Date.now()): string {
  if (at == null) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
const yn = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "no");
export function formatPlan(plan: BackfillPlan): string {
  return [
    "backfill dry run (nothing was written)",
    `  threads:                ${plan.threads}`,
    `  messages:               ${plan.messages}`,
    `  tokens (about):         ${plan.tokens}`,
    `  reasoning messages:     ${plan.reasoningMessages}`,
    `  already in honcho:      ${plan.skippedAlreadyInHoncho} (skipped)`,
  ].join("\n");
}
export function formatHarness(state: HarnessState): string {
  return [
    `machine ${state.machineId}`,
    `  claude: hook ${state.claude.hookInstalled ? "installed" : "not installed"}, claude-honcho ${state.claude.handedOver ? "handed over" : "active"}${state.claude.pluginVersion ? ` (${state.claude.pluginVersion})` : ""}`,
    `  codex:  hook ${state.codex.hookInstalled ? "installed" : "not installed"}, honcho ${state.codex.handedOver ? "handed over" : "active"}, hook trusted: ${yn(state.codex.trusted)}`,
    `  backups: ${state.backups.length ? state.backups.join(", ") : "none"}`,
  ].join("\n");
}
/** `--since` takes a date or timestamp; normalized to ISO so every layer agrees. */
export function parseSince(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new PluginCliError(`invalid --since "${value}"`, { code: "invalid_value", hint: "Use a date like 2026-01-31 or a full ISO timestamp." });
  return new Date(t).toISOString();
}
function needThread(ctx: PluginCliContext): string {
  if (!ctx.threadId) throw new PluginCliError("no current thread", { code: "missing_thread", hint: "Run inside a bb thread, or pass --project to pause the project." });
  return ctx.threadId;
}

export function registerCli(bb: BbPluginApi, services: CliServices): void {
  const { capture, backfill, harness } = services;
  const machine = { type: "string", description: "Machine id (default: this machine)" } as const;
  const harnessCommand = (summary: string, action: "state" | "connect" | "handOver" | "undo") => cliCommand({
    summary, options: { machine, json },
    async run({ options }) {
      const state = await harness[action](options.machine);
      return out(state, formatHarness(state), options.json);
    },
  });
  bb.cli.register(defineCli({
    name: "honcho",
    summary: "Honcho memory: status, pause, backfill and harness hand-over",
    commands: {
      status: cliCommand({
        summary: "Memory health, plus the current thread's status",
        options: { json },
        async run({ options }, ctx) {
          const health = await capture.health();
          const thread = ctx.threadId ? await capture.threadStatus(ctx.threadId) : null;
          const lines = [
            `honcho: ${health.authFailing ? "auth failing" : health.tripwire ? "tripwire" : "ok"}`,
            `  queued: ${health.queued}${health.oldestPendingAt ? ` (oldest ${ago(health.oldestPendingAt)})` : ""}`,
            ...(health.tripwire ? [`  tripwire: ${health.tripwire}`] : []),
            ...(thread ? [`thread ${thread.threadId}: ${thread.state}${thread.reason ? ` (${thread.reason})` : ""}`,
              `  last upload: ${ago(thread.lastUploadAt)}, queued: ${thread.queued}, scope: ${thread.scope ?? "none"}`] : []),
          ];
          return out({ health, thread }, lines.join("\n"), options.json);
        },
      }),
      pause: cliCommand({
        summary: "Pause (or resume) memory capture for the current thread or project",
        description: "Paused turns are never queued or uploaded; nothing earlier is deleted.",
        options: {
          project: { type: "boolean", description: "Pause the current project instead of the current thread" },
          off: { type: "boolean", description: "Resume capture instead of pausing" }, json,
        },
        async run({ options }, ctx) {
          let target: { kind: "thread" | "project"; id: string };
          if (options.project) {
            if (!ctx.projectId) throw new PluginCliError("no current project", { code: "missing_project", hint: "Run inside a bb thread." });
            target = { kind: "project", id: ctx.projectId };
          } else target = { kind: "thread", id: needThread(ctx) };
          await capture.setPaused(target, !options.off);
          return out({ ok: true, ...target, paused: !options.off }, `memory ${options.off ? "resumed" : "paused"} for ${target.kind} ${target.id}`, options.json);
        },
      }),
      backfill: cliCommand({
        summary: "Import past bb threads into Honcho (dry run first)",
        description: "Stops at each thread's switch-over marker, skips what claude-honcho or codex already wrote, and is resumable.",
        options: {
          "dry-run": { type: "boolean", description: "Show what would be imported; writes nothing" },
          start: { type: "boolean", description: "Start (or resume) the import in the background" },
          stop: { type: "boolean", description: "Stop a running import; it resumes where it left off" },
          progress: { type: "boolean", description: "Show import progress" },
          project: { type: "string", description: "Only this project id" },
          since: { type: "string", description: "Only messages on or after this date (e.g. 2026-01-31)" },
          json,
        },
        constraints: [{ kind: "exactly-one", options: ["dry-run", "start", "stop", "progress"] }],
        async run({ options }) {
          const filter = { ...(options.project ? { projectId: options.project } : {}), ...(options.since ? { since: parseSince(options.since) } : {}) };
          if (options["dry-run"]) { const plan = await backfill.dryRun(filter); return out(plan, formatPlan(plan), options.json); }
          if (options.start) { await backfill.start(filter); return out({ ok: true, started: true }, "backfill started; check `bb honcho backfill --progress`", options.json); }
          if (options.stop) { await backfill.stop(); return out({ ok: true, stopped: true }, "backfill stopped", options.json); }
          const p = await backfill.progress();
          const pct = p.total ? ` (${Math.floor((p.done / p.total) * 100)}%)` : "";
          return out(p, `backfill ${p.running ? "running" : "idle"}: ${p.done}/${p.total} messages${pct}${p.error ? `\n  error: ${p.error}` : ""}`, options.json);
        },
      }),
      "harness state": harnessCommand("Show claude/codex hook and hand-over state", "state"),
      "harness connect": harnessCommand("Install the bb-gated Honcho hooks", "connect"),
      "harness hand-over": harnessCommand("Turn off claude-honcho and codex honcho inside bb, with a backup", "handOver"),
      "harness undo": harnessCommand("Undo the last hand-over from its backup", "undo"),
    },
  }));
}

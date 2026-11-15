import { PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import type { BbPluginApi, PluginCliContext, PluginCliResult } from "@get-bb/plugin-sdk";
import type { BackfillPlan, BackfillService, CaptureService, HarnessService, HarnessState, HarnessUndoStep } from "./contract";

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
export function formatPlan(plan: BackfillPlan): string {
  return [
    "backfill dry run (nothing was written)",
    `  threads:                ${plan.threads}`,
    `  messages:               ${plan.messages}`,
    `  tokens (about):         ${plan.tokens}`,
    `  reasoning messages:     ${plan.reasoningMessages}`,
    `  already in honcho:      ${plan.skippedAlreadyInHoncho} (skipped)`,
    ...(plan.notYetSeenByCapture ? [`  waiting for capture:    ${plan.notYetSeenByCapture} (skipped until live capture sees them)`] : []),
  ].join("\n");
}
const HOOK_HINT = "needed for per-turn recall; add it with: bb honcho harness connect";
const trustedText = (trusted: boolean | null) => (trusted === null ? "unknown" : trusted ? "yes" : "no (codex asks you to approve the new hook once)");
export function formatHarness(state: HarnessState): string {
  return [
    `machine ${state.machineId}`,
    `  claude: hook ${state.claude.hookInstalled ? "installed" : `not installed (${HOOK_HINT})`}, claude-honcho ${state.claude.handedOver ? "handed over" : "active"}${state.claude.pluginVersion ? ` (${state.claude.pluginVersion})` : ""}`,
    `  codex:  hook ${state.codex.hookInstalled ? "installed" : `not installed (${HOOK_HINT})`}, honcho ${state.codex.handedOver ? "handed over" : "active"}, hook trusted: ${trustedText(state.codex.trusted)}`,
    `  backups: ${state.backups.length ? `${state.backups.join(", ")} (harness undo can restore these)` : "none (nothing to undo)"}`,
  ].join("\n");
}
/** `--since` takes a date or timestamp; normalized to ISO so every layer agrees. */
export function parseSince(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new PluginCliError(`invalid --since "${value}"`, { code: "invalid_value", hint: "Use a date like 2026-01-31 or a full ISO timestamp." });
  return new Date(t).toISOString();
}
/** `--json` works anywhere in the argv: the parser only reads it after the command, so move every copy to the end. */
export function moveJsonFlagLast(argv: string[]): string[] {
  if (!argv.includes("--json")) return argv;
  return [...argv.filter(arg => arg !== "--json"), "--json"];
}
/** The chat's title from bb, or null when bb can't say; the CLI still works without it. */
async function chatTitle(bb: BbPluginApi, threadId: string): Promise<string | null> {
  try {
    const thread = await bb.sdk.threads.get({ threadId }) as { title?: string | null } | undefined;
    return thread?.title?.trim() || null;
  } catch {
    return null;
  }
}
const chatLabel = (title: string | null, threadId: string) => (title ? `"${title}" (${threadId})` : threadId);
/** The tripwire message names the chat that the old plugin is still saving (see capture's checkTripwire). */
async function tripwireSentence(bb: BbPluginApi, tripwire: string): Promise<string> {
  const threadId = tripwire.match(/capturing thread (\S+)$/)?.[1];
  const tail = "it stops by itself after that chat restarts";
  if (!threadId) return `the old honcho plugin is still saving a chat; ${tail}`;
  return `the old honcho plugin is still saving chat ${chatLabel(await chatTitle(bb, threadId), threadId)}; ${tail}`;
}
const isNotFound = (error: unknown) => (error as { status?: unknown } | null)?.status === 404
  || /\bHTTP 404\b/.test(error instanceof Error ? error.message : String(error));
/** Turns a bb 404 into a plain sentence; anything else is rethrown unchanged. */
function plainNotFound(error: unknown, projectId: string | undefined): never {
  if (!isNotFound(error)) throw error;
  if (projectId) throw new PluginCliError(`no project "${projectId}". list projects with: bb project list`, { code: "project_not_found" });
  throw new PluginCliError(`not found: ${error instanceof Error ? error.message : String(error)}`, { code: "not_found" });
}

export function registerCli(bb: BbPluginApi, services: CliServices): void {
  const { capture, backfill, harness } = services;
  const machine = { type: "string", description: "Machine id (default: this machine)" } as const;
  const harnessCommand = (summary: string, action: "state" | "connect" | "handOver") => cliCommand({
    summary, options: { machine, json },
    async run({ options }) {
      const state = await harness[action](options.machine);
      return out(state, formatHarness(state), options.json);
    },
  });
  const cli = defineCli({
    name: "honcho",
    summary: "Honcho memory: status, pause, backfill and harness hand-over",
    commands: {
      status: cliCommand({
        summary: "Memory health, plus the current thread's status",
        options: { json },
        async run({ options }, ctx) {
          const health = await capture.health();
          const thread = ctx.threadId ? await capture.threadStatus(ctx.threadId) : null;
          if (options.json) return out({ health, thread }, "", true);
          const tripwire = health.tripwire ? `  ${await tripwireSentence(bb, health.tripwire)}` : null;
          const lines = [
            `honcho: ${health.authFailing ? "auth failing" : health.tripwire ? "needs attention" : "ok"}`,
            `  queued: ${health.queued}${health.oldestPendingAt ? ` (oldest ${ago(health.oldestPendingAt)})` : ""}`,
            ...(tripwire ? [tripwire] : []),
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
            if (!ctx.projectId) throw new PluginCliError("--project needs a current project", { code: "missing_project", hint: "Run it from a chat that belongs to a project." });
            target = { kind: "project", id: ctx.projectId };
          } else {
            if (!ctx.threadId) throw new PluginCliError("pause must run inside a chat", { code: "missing_thread", hint: "Run it from a chat, or pass --project to pause the current project." });
            target = { kind: "thread", id: ctx.threadId };
          }
          await capture.setPaused(target, !options.off);
          if (options.json) return out({ ok: true, ...target, paused: !options.off }, "", true);
          const label = target.kind === "thread" ? chatLabel(await chatTitle(bb, target.id), target.id) : `project ${target.id}`;
          const undo = `bb honcho pause${options.project ? " --project" : ""}${options.off ? "" : " --off"}`;
          return out({ ok: true, ...target, paused: !options.off }, `${options.off ? "resumed" : "paused"} memory for ${label}. undo: ${undo}`, false);
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
          const fail = (error: unknown) => plainNotFound(error, options.project);
          if (options["dry-run"]) { const plan = await backfill.dryRun(filter).catch(fail); return out(plan, formatPlan(plan), options.json); }
          if (options.start) { await backfill.start(filter).catch(fail); return out({ ok: true, started: true }, "backfill started; check `bb honcho backfill --progress`", options.json); }
          if (options.stop) { await backfill.stop(); return out({ ok: true, stopped: true }, "backfill stopped", options.json); }
          const p = await backfill.progress();
          const pct = p.total ? ` (${Math.floor((p.done / p.total) * 100)}%)` : "";
          return out(p, `backfill ${p.running ? "running" : "idle"}: ${p.done}/${p.total} messages${pct}${p.error ? `\n  error: ${p.error}` : ""}`, options.json);
        },
      }),
      "harness state": harnessCommand("Show claude/codex hook and hand-over state", "state"),
      "harness connect": harnessCommand("Install the bb-gated Honcho hooks", "connect"),
      "harness hand-over": harnessCommand("Turn off claude-honcho and codex honcho inside bb, with a backup", "handOver"),
      "harness undo": cliCommand({
        summary: "Undo connect or hand over (one step with --step) from bb's backups",
        options: {
          machine,
          step: { type: "enum", values: ["connect", "hand-over"], description: "Undo only this step: connect (the bb hooks) or hand-over (claude-honcho / codex honcho)" },
          json,
        },
        async run({ options }) {
          const step: HarnessUndoStep | undefined = options.step === "hand-over" ? "handOver" : options.step === "connect" ? "connect" : undefined;
          const state = await harness.undo(options.machine, step);
          return out(state, formatHarness(state), options.json);
        },
      }),
    },
  });
  // `--json` is accepted before the command too; the registration keeps its help rendering.
  bb.cli.register({ ...cli, run: (argv, ctx) => cli.run(moveJsonFlagLast(argv), ctx) });
}

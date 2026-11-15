// Harness host ops: every harness file operation runs in the plugin's host
// worker on the machine that runs the threads, so remote machines work.
//
// host.ts (owned by the recall slice) merges these into its single host entry:
//
//   import { registerHarnessHostOps } from "./lib/harness/host-ops.js";
//   const contract = { ...recallContract };   // plain mutable objects
//   const handlers = { ...recallHandlers };
//   registerHarnessHostOps({ contract, handlers });
//   export default experimental_defineHostEntry({ contract, handlers });
//
// or spreads `harnessHostContract` / `harnessHostHandlers()` itself.
import { homedir } from "node:os";
import type { ExperimentalHostRpcContext, PluginRpcMethodContract } from "@get-bb/plugin-sdk";
import { connect, handOver, harnessState, prepareEnv, resolveHarnessPaths, undo, type EnvPaths, type HarnessPaths, type HostHarnessState, type UndoStep } from "./ops.js";
import { emptyInput, guardSchema, isRecord } from "./schema.js";

const isState = (v: unknown) => isRecord(v) && isRecord(v.claude) && isRecord(v.codex) && Array.isArray(v.backups);
const isUndoInput = (v: unknown) => isRecord(v) && (v.step === undefined || v.step === "connect" || v.step === "handOver");

export interface HarnessOpResults {
  harnessEnv: EnvPaths;
  harnessState: HostHarnessState;
  harnessConnect: { state: HostHarnessState; backup: string | null; codexTrustError?: string };
  harnessHandOver: { state: HostHarnessState; backup: string | null };
  harnessUndo: { state: HostHarnessState; restored: string[] };
}
export interface HarnessOpInputs {
  harnessEnv: Record<string, never>;
  harnessState: Record<string, never>;
  harnessConnect: Record<string, never>;
  harnessHandOver: Record<string, never>;
  harnessUndo: { step?: UndoStep };
}
export type HarnessOp = keyof HarnessOpResults;

export const harnessHostContract = {
  harnessEnv: {
    experimental_description: "Prepare the bb-owned honcho config paths on this host and report them.",
    experimental_retryable: true,
    input: emptyInput,
    output: guardSchema<EnvPaths>("env paths", (v) => isRecord(v) && typeof v.claudeConfigPath === "string" && typeof v.codexConfigDir === "string" && typeof v.recallDir === "string"),
  },
  harnessState: {
    experimental_description: "Read this host's harness hook and handover state.",
    experimental_retryable: true,
    input: emptyInput,
    output: guardSchema<HostHarnessState>("harness state", isState),
  },
  harnessConnect: {
    experimental_description: "Install the bb-gated honcho hook into Claude Code and Codex.",
    input: emptyInput,
    output: guardSchema<HarnessOpResults["harnessConnect"]>("connect result", (v) => isRecord(v) && isState(v.state)),
  },
  harnessHandOver: {
    experimental_description: "Turn off claude-honcho and codex-honcho on this host, with a backup.",
    input: emptyInput,
    output: guardSchema<HarnessOpResults["harnessHandOver"]>("handover result", (v) => isRecord(v) && isState(v.state)),
  },
  harnessUndo: {
    experimental_description: "Undo connect, hand over, or both, from bb's backups.",
    input: guardSchema<HarnessOpInputs["harnessUndo"]>("undo input", isUndoInput),
    output: guardSchema<HarnessOpResults["harnessUndo"]>("undo result", (v) => isRecord(v) && isState(v.state) && Array.isArray(v.restored)),
  },
} as const satisfies Record<HarnessOp, PluginRpcMethodContract>;

export interface HarnessHostOptions {
  /** Defaults to os.homedir(). Tests pass a temp dir. */
  home?: string;
  /** CLAUDE_CONFIG_DIR / CODEX_HOME are honoured from here; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Overrides the host entry's dataDir (tests). */
  dataDir?: string;
}

type Handler<Op extends HarnessOp> = (input: HarnessOpInputs[Op], context: Pick<ExperimentalHostRpcContext, "experimental_paths">) => Promise<HarnessOpResults[Op]>;

export function harnessHostHandlers(options: HarnessHostOptions = {}): { [Op in HarnessOp]: Handler<Op> } {
  let queue: Promise<unknown> = Promise.resolve();
  // Edits of the same files never interleave inside one worker.
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn);
    queue = run.catch(() => undefined);
    return run;
  };
  const paths = (context: Pick<ExperimentalHostRpcContext, "experimental_paths">): HarnessPaths =>
    resolveHarnessPaths({ home: options.home ?? homedir(), dataDir: options.dataDir ?? context.experimental_paths.dataDir, env: options.env ?? process.env });
  return {
    harnessEnv: (_input, context) => serial(() => prepareEnv(paths(context))),
    harnessState: (_input, context) => harnessState(paths(context)),
    harnessConnect: (_input, context) => serial(async () => {
      const p = paths(context);
      const result = await connect(p);
      return { ...result, state: await harnessState(p) };
    }),
    harnessHandOver: (_input, context) => serial(async () => {
      const p = paths(context);
      const result = await handOver(p);
      return { ...result, state: await harnessState(p) };
    }),
    harnessUndo: (input, context) => serial(async () => {
      const p = paths(context);
      const result = await undo(p, input.step);
      return { ...result, state: await harnessState(p) };
    }),
  };
}

/** Merges the harness ops into a host entry's contract and handlers (see the header). */
export function registerHarnessHostOps(
  hostApi: { contract: Record<string, PluginRpcMethodContract>; handlers: Record<string, unknown> },
  options: HarnessHostOptions = {},
): void {
  for (const name of Object.keys(harnessHostContract)) {
    if (name in hostApi.contract || name in hostApi.handlers) throw new Error(`host op ${name} is already registered`);
  }
  Object.assign(hostApi.contract, harnessHostContract);
  Object.assign(hostApi.handlers, harnessHostHandlers(options));
}

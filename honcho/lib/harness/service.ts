import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ActivityLog, HarnessService, HarnessState } from "../contract.js";
import { harnessHostContract, type HarnessOp, type HarnessOpInputs, type HarnessOpResults } from "./host-ops.js";
import type { HostHarnessState, UndoStep } from "./ops.js";

/** Calls one harness host op on one enrolled host. */
export type HarnessCaller = <Op extends HarnessOp>(op: Op, input: HarnessOpInputs[Op], hostId: string) => Promise<HarnessOpResults[Op]>;

/**
 * The default caller. server.ts may pass its own (built from the full host
 * contract) when one client per plugin is required.
 */
export function harnessHostCaller(bb: Pick<BbPluginApi, "hosts">): HarnessCaller {
  const client = bb.hosts.experimental_client({ contract: harnessHostContract });
  return (op, input, hostId) => client.call(op, input as never, { hostId }) as Promise<HarnessOpResults[typeof op]>;
}

export interface HarnessDeps {
  activity: ActivityLog;
  /** Defaults to harnessHostCaller(bb). */
  call?: HarnessCaller;
  /** The host to use when the caller names none. Defaults to the only enrolled host. */
  defaultMachineId?: () => Promise<string>;
}

export interface HarnessServiceWithSteps extends HarnessService {
  /** No step undoes both connect and hand over. */
  undo(machineId?: string, step?: UndoStep): Promise<HarnessState>;
}

export function createHarnessService(bb: Pick<BbPluginApi, "hosts" | "sdk">, deps: HarnessDeps): HarnessServiceWithSteps {
  let caller: HarnessCaller | undefined = deps.call;
  const call: HarnessCaller = (op, input, hostId) => (caller ??= harnessHostCaller(bb))(op, input, hostId);

  async function machine(machineId?: string): Promise<string> {
    if (machineId) return machineId;
    if (deps.defaultMachineId) return deps.defaultMachineId();
    const hosts = (await bb.sdk.hosts.list()).filter((h) => h.lifecycle.phase === "active");
    const connected = hosts.filter((h) => h.status === "connected");
    const pick = connected.length === 1 ? connected[0] : hosts.length === 1 ? hosts[0] : undefined;
    if (!pick) throw new Error("Several machines are enrolled; choose one.");
    return pick.id;
  }

  const view = (machineId: string, state: HostHarnessState): HarnessState => ({ machineId, ...state });

  async function act<T extends { state: HostHarnessState }>(machineId: string | undefined, label: string, run: (hostId: string) => Promise<T>, summary: (r: T) => string): Promise<HarnessState> {
    const hostId = await machine(machineId);
    try {
      const result = await run(hostId);
      deps.activity.record({ kind: "harness", summary: summary(result) });
      return view(hostId, result.state);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.activity.record({ kind: "failure", summary: `${label} failed on ${hostId}`, error: message });
      throw error;
    }
  }

  return {
    async state(machineId) {
      const hostId = await machine(machineId);
      return view(hostId, await call("harnessState", {}, hostId));
    },
    connect: (machineId) => act(machineId, "connect harnesses", (h) => call("harnessConnect", {}, h), (r) =>
      `connected harnesses${r.backup ? ` (backup ${r.backup})` : " (already connected)"}${r.codexTrustError ? `; codex hook not trusted: ${r.codexTrustError}` : ""}`),
    handOver: (machineId) => act(machineId, "hand over", (h) => call("harnessHandOver", {}, h), (r) =>
      `handed honcho over to bb${r.backup ? ` (backup ${r.backup})` : " (already handed over)"}`),
    undo: (machineId, step) => act(machineId, "undo", (h) => call("harnessUndo", step ? { step } : {}, h), (r) =>
      r.restored.length ? `undid ${step ?? "connect and hand over"} (${r.restored.length} backup set${r.restored.length === 1 ? "" : "s"})` : `nothing to undo for ${step ?? "harnesses"}`),
  };
}

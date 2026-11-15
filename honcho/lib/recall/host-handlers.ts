import { join } from "node:path";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk";
import { deleteRecallFile, writeRecallEntry, writeSkipMarker } from "./cache-file.js";

/** How long the worker stays warm after the last recall call. The daemon's own
 * idle stop is 5 minutes, and a cold start (up to 10 s) misses the hook budget. */
export const WARM_MS = 30 * 60_000;

export function recallDir(context: Pick<ExperimentalHostRpcContext, "experimental_paths">): string {
  return join(context.experimental_paths.dataDir, "recall");
}

/** Host-side state: one retained-worker lease and per-thread write serialization. */
export function createRecallHostHandlers() {
  let lease: ExperimentalHostWorkerLease | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const chains = new Map<string, Promise<unknown>>();
  const release = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    const held = lease;
    lease = null;
    void held?.dispose();
  };
  const warm = (context: ExperimentalHostRpcContext) => {
    if (!lease) {
      lease = context.experimental_retainWorker();
      context.lifecycle.signal.addEventListener("abort", release, { once: true });
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(release, WARM_MS);
    timer.unref?.();
  };
  /** Per-thread serialization, so a delete never races a write. */
  const serial = async <T>(threadId: string, task: () => Promise<T>): Promise<T> => {
    const previous = chains.get(threadId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    chains.set(threadId, run);
    try { return await run; } finally { if (chains.get(threadId) === run) chains.delete(threadId); }
  };
  return {
    handlers: {
      "recall.write": async (input: { threadId: string; hash: string; memory: string }, context: ExperimentalHostRpcContext) => {
        warm(context);
        // createdAt is stamped here, on the host the hook runs on, so freshness never compares two clocks.
        const { entry, path } = await serial(input.threadId, () =>
          writeRecallEntry(recallDir(context), input.threadId, { hash: input.hash, memory: input.memory, createdAt: Date.now() }));
        return { counter: entry.counter, path };
      },
      "recall.skip": async (input: { threadId: string }, context: ExperimentalHostRpcContext) => {
        warm(context);
        const { path } = await serial(input.threadId, () => writeSkipMarker(recallDir(context), input.threadId));
        return { path };
      },
      "recall.delete": async (input: { threadId: string }, context: ExperimentalHostRpcContext) => {
        const deleted = await serial(input.threadId, () => deleteRecallFile(recallDir(context), input.threadId));
        return { deleted };
      },
    },
    dispose: release,
  };
}

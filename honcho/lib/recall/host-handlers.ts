import { join } from "node:path";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk";
import { writeRecallEntry } from "./cache-file.js";

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
  return {
    handlers: {
      "recall.write": async (input: { threadId: string; text: string; memory: string; createdAt: number }, context: ExperimentalHostRpcContext) => {
        warm(context);
        const previous = chains.get(input.threadId) ?? Promise.resolve();
        const run = previous.catch(() => undefined).then(() => writeRecallEntry(recallDir(context), input.threadId, input));
        chains.set(input.threadId, run);
        try {
          const { entry, path } = await run;
          return { counter: entry.counter, path };
        } finally {
          if (chains.get(input.threadId) === run) chains.delete(input.threadId);
        }
      },
    },
    dispose: release,
  };
}

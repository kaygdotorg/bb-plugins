import type { BbPluginApi, ExperimentalPluginProviderEnvEntry, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { HonchoError, type Message } from "../honcho-client.js";
import { normalizePromptText } from "./cache-file.js";
import { formatTurnMemory } from "./format.js";
import { recallInternals, type RecallDeps, type RecallRuntime } from "./service.js";

/** Harnesses with a prompt hook that reads the recall cache file. */
export const HOOK_PROVIDERS = ["claude-code", "codex"] as const;
const SEARCH_LIMIT = 8;

/**
 * Per-turn prefetch: answer `proceed` at once, then search Honcho off the
 * dispatch path and have the thread's own host write the cache file.
 * Also contributes BB_HONCHO_RECALL_DIR and BB_HONCHO_HOOK_BUDGET_MS (non-secret).
 */
export function registerDispatchPrefetch(bb: BbPluginApi, _deps: RecallDeps, recall: RecallRuntime): { idle(): Promise<void> } {
  const { shared, settings, deps } = recallInternals(recall);
  const running = new Set<Promise<void>>();
  const dirs = new Map<string, string>();

  async function prefetch(ctx: MessageDispatchHookContext): Promise<void> {
    const hostId = ctx.host?.id;
    const text = normalizePromptText(ctx.input.text ?? "");
    if (!hostId || !text || !shared.host) return;
    const threadId = ctx.thread.id;
    const sideChat = ctx.thread.originKind === "fork" && ctx.thread.originPluginId === "side-chat";
    const parentThreadId = ctx.thread.parentThreadId ?? ctx.thread.sourceThreadId ?? ctx.parentThreadId ?? null;
    const scopeInput = {
      threadId, parentThreadId, sideChat,
      hostId: ctx.environment?.hostId ?? hostId, path: ctx.environment?.path ?? null,
      isGitRepo: ctx.environment ? ctx.environment.isGitRepo : null, projectName: ctx.project.name,
    };
    let memory = "";
    let count = 0;
    try {
      const scope = await shared.scopes.resolve(scopeInput);
      const { client, peer } = await shared.client();
      const level = await shared.keyLevel.get();
      let results: Message[];
      if (level === "restricted") results = await client.searchPeer(peer, { query: text, limit: SEARCH_LIMIT });
      else {
        try { results = await client.searchWorkspace({ query: text, scope, limit: SEARCH_LIMIT }); }
        catch (error) {
          if (!(error instanceof HonchoError && error.kind === "auth" && error.status === 403)) throw error;
          shared.keyLevel.noteForbidden();
          results = await client.searchPeer(peer, { query: text, limit: SEARCH_LIMIT });
        }
      }
      const exclude = new Set([threadId, ...(parentThreadId ? [parentThreadId] : [])]);
      memory = formatTurnMemory(results, { peer, exclude });
      count = memory ? memory.split("\n- ").length - 1 : 0;
    } catch (error) {
      deps.activity.record({ kind: "failure", threadId, summary: "per-turn recall search failed", error: error instanceof HonchoError ? error.kind : "error" });
    }
    // An empty entry still tells the hook to stop waiting for this prompt.
    await shared.host.call("recall.write", { threadId, text, memory, createdAt: Date.now() }, { hostId, signal: AbortSignal.timeout(15_000) });
    if (count) deps.activity.record({ kind: "recall", threadId, summary: `per-turn memory: ${count} excerpt${count === 1 ? "" : "s"}` });
  }

  bb.experimental_hooks.on("message.dispatch", ctx => {
    try {
      const provider = ctx.requestedExecution.providerId;
      if (ctx.initiator !== "system" && (HOOK_PROVIDERS as readonly string[]).includes(provider)) {
        const run: Promise<void> = prefetch(ctx).catch(error => { bb.log.warn(`honcho prefetch: ${error instanceof Error ? error.name : "error"}`); })
          .finally(() => { running.delete(run); });
        running.add(run);
      }
    } catch { /* never block or fail a dispatch */ }
    return { action: "proceed" };
  });

  for (const providerId of HOOK_PROVIDERS) {
    bb.providers.experimental_contributeEnv(providerId, async ({ hostId }) => {
      const entries: ExperimentalPluginProviderEnvEntry[] = [
        { name: "BB_HONCHO_HOOK_BUDGET_MS", value: String(settings.hookBudgetMs()), reason: "How long the honcho prompt hook waits for per-turn memory" },
      ];
      let dir = dirs.get(hostId);
      if (!dir && shared.host) {
        try {
          dir = (await shared.host.call("recall.dir", {}, { hostId, signal: AbortSignal.timeout(5_000) })).dir;
          dirs.set(hostId, dir);
        } catch { /* fallback: no dir, the hook exits and the session gets session-start recall only */ }
      }
      if (dir) entries.unshift({ name: "BB_HONCHO_RECALL_DIR", value: dir, reason: "Where the honcho prompt hook reads per-turn memory (not secret)" });
      return entries;
    });
  }
  return { async idle() { while (running.size) await Promise.all([...running]); } };
}

import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
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
 * The hook's env (BB_HONCHO_RECALL_DIR, BB_HONCHO_HOOK_BUDGET_MS) comes from the
 * harness slice's registerProviderEnv: bb allows one env resolver per provider.
 */
export function registerDispatchPrefetch(bb: BbPluginApi, _deps: RecallDeps, recall: RecallRuntime): { idle(): Promise<void> } {
  const { shared, deps } = recallInternals(recall);
  const running = new Set<Promise<void>>();

  async function prefetch(ctx: MessageDispatchHookContext): Promise<void> {
    const hostId = ctx.host?.id;
    const text = normalizePromptText(ctx.input.text ?? "");
    if (!hostId || !text || !shared.host) return;
    const threadId = ctx.thread.id;
    const sideChat = ctx.thread.originKind === "fork" && ctx.thread.originPluginId === "side-chat";
    const parentThreadId = ctx.thread.parentThreadId ?? ctx.thread.sourceThreadId ?? ctx.parentThreadId ?? null;
    const scopeInput = {
      threadId, parentThreadId, sideChat,
      projectId: ctx.project.id, environmentId: ctx.environment?.id ?? ctx.thread.environmentId ?? null,
      path: ctx.environment?.path ?? null,
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

  return { async idle() { while (running.size) await Promise.all([...running]); } };
}

import type { BbPluginApi, MessageDispatchHookContext } from "@get-bb/plugin-sdk";
import { HonchoError, type Message } from "../honcho-client.js";
import { normalizePromptText, promptHash } from "./cache-file.js";
import { formatTurnMemory } from "./format.js";
import { recallInternals, type RecallDeps, type RecallRuntime } from "./service.js";

/** Harnesses with a prompt hook that reads the recall cache file. */
export const HOOK_PROVIDERS = ["claude-code", "codex"] as const;
const SEARCH_LIMIT = 8;
/** kv: the hosts a thread's recall file was written on, for thread.deleted. */
export const recallHostsKey = (threadId: string) => `recall:hosts:${threadId}`;

/**
 * Per-turn prefetch: answer `proceed` at once, then search Honcho off the
 * dispatch path and have the thread's own host write the cache file.
 * The hook's env (BB_HONCHO_RECALL_DIR, BB_HONCHO_HOOK_BUDGET_MS) comes from the
 * harness slice's registerProviderEnv: bb allows one env resolver per provider.
 */
export function registerDispatchPrefetch(bb: BbPluginApi, _deps: RecallDeps, recall: RecallRuntime): { idle(): Promise<void> } {
  const { shared, deps } = recallInternals(recall);
  const running = new Set<Promise<void>>();

  const knownHosts = new Map<string, string[]>();
  async function rememberHost(threadId: string, hostId: string): Promise<void> {
    const hosts = knownHosts.get(threadId) ?? (await bb.storage.kv.get<string[]>(recallHostsKey(threadId))) ?? [];
    knownHosts.set(threadId, hosts);
    if (hosts.includes(hostId)) return;
    hosts.push(hostId);
    await bb.storage.kv.set(recallHostsKey(threadId), hosts);
  }

  async function prefetch(ctx: MessageDispatchHookContext): Promise<void> {
    const hostId = ctx.host?.id;
    const text = normalizePromptText(ctx.input.text ?? "");
    if (!hostId || !text || !shared.host) return;
    const threadId = ctx.thread.id;
    const sideChat = ctx.thread.originKind === "fork" && ctx.thread.originPluginId === "side-chat";
    const parentThreadId = ctx.thread.parentThreadId ?? ctx.thread.sourceThreadId ?? ctx.parentThreadId ?? null;
    const environmentId = ctx.environment?.id ?? ctx.thread.environmentId ?? null;
    // Paused or deny-listed: no search; the skip marker (no hash, no prompt data) tells the hook not to wait.
    if (await shared.gate.blocked({ id: threadId, projectId: ctx.project.id, environmentId, contextThreadId: sideChat ? parentThreadId : null })) {
      await shared.host.call("recall.skip", { threadId }, { hostId, signal: AbortSignal.timeout(15_000) });
      await rememberHost(threadId, hostId).catch(() => undefined);
      return;
    }
    const scopeInput = {
      threadId, parentThreadId, sideChat,
      projectId: ctx.project.id, environmentId,
      path: ctx.environment?.path ?? null,
      isGitRepo: ctx.environment ? ctx.environment.isGitRepo : null, projectName: ctx.project.name,
    };
    let memory = "";
    let count = 0;
    try {
      const redactor = await shared.gate.redactor();
      const query = redactor(text).text;
      const scope = await shared.scopes.resolve(scopeInput);
      const { client, peer } = await shared.client();
      const level = await shared.keyLevel.get();
      let results: Message[];
      if (level === "restricted") results = await client.searchPeer(peer, { query, limit: SEARCH_LIMIT });
      else {
        try { results = await client.searchWorkspace({ query, scope, limit: SEARCH_LIMIT }); }
        catch (error) {
          if (!(error instanceof HonchoError && error.kind === "auth" && error.status === 403)) throw error;
          shared.keyLevel.noteForbidden();
          results = await client.searchPeer(peer, { query, limit: SEARCH_LIMIT });
        }
      }
      const exclude = new Set([threadId, ...(parentThreadId ? [parentThreadId] : [])]);
      const formatted = formatTurnMemory(results, { peer, exclude });
      count = formatted ? formatted.split("\n- ").length - 1 : 0;
      memory = formatted ? redactor(formatted).text : "";
    } catch (error) {
      deps.activity.record({ kind: "failure", threadId, summary: "per-turn recall search failed", error: error instanceof HonchoError ? `${error.kind}${error.status ? ` ${error.status}` : ""}` : `${(error as Error)?.name ?? "error"} ${String((error as Error)?.message ?? "").slice(0, 160)}` });
    }
    // Only the hash of the normalized prompt goes to the host. An empty entry tells the hook to stop waiting.
    await shared.host.call("recall.write", { threadId, hash: promptHash(text), memory }, { hostId, signal: AbortSignal.timeout(15_000) });
    await rememberHost(threadId, hostId).catch(() => undefined);
    if (count) deps.activity.record({ kind: "recall", threadId, summary: `per-turn memory: ${count} excerpt${count === 1 ? "" : "s"}` });
  }

  bb.events.on("thread.deleted", ({ thread }) => {
    const run: Promise<void> = (async () => {
      const key = recallHostsKey(thread.id);
      const hosts = knownHosts.get(thread.id) ?? (await bb.storage.kv.get<string[]>(key)) ?? [];
      knownHosts.delete(thread.id);
      if (!hosts.length || !shared.host) return;
      const left: string[] = [];
      for (const hostId of hosts) {
        try { await shared.host.call("recall.delete", { threadId: thread.id }, { hostId, signal: AbortSignal.timeout(15_000) }); }
        catch { left.push(hostId); }
      }
      if (left.length) {
        await bb.storage.kv.set(key, left);
        deps.activity.record({ kind: "failure", threadId: thread.id, summary: "recall cache file not deleted (host unreachable)", error: "offline" });
      } else await bb.storage.kv.delete(key);
    })().catch(error => { bb.log.warn(`honcho recall delete: ${error instanceof Error ? error.name : "error"}`); })
      .finally(() => { running.delete(run); });
    running.add(run);
  });

  bb.experimental_hooks.on("message.dispatch", ctx => {
    try {
      const provider = ctx.requestedExecution.providerId;
      void shared.gate.checkDenied({ id: ctx.thread.id, projectId: ctx.project.id, environmentId: ctx.environment?.id ?? ctx.thread.environmentId ?? null });
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

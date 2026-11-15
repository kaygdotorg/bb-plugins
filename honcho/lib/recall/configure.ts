import type { BbPluginApi, PluginAgentConfiguration, PluginAgentConfigurationContext } from "@get-bb/plugin-sdk";
import { buildInstructions } from "./format.js";
import { recallInternals, type RecallDeps, type RecallRuntime } from "./service.js";
import { ScopeResolver } from "./shared.js";
import { HONCHO_TOOL_NAMES } from "../tools/names.js";

export const SIDE_CHAT_PLUGIN_ID = "side-chat";

export function isSideChat(ctx: Pick<PluginAgentConfigurationContext, "origin">): boolean {
  return ctx.origin.kind === "fork" && ctx.origin.pluginId === SIDE_CHAT_PLUGIN_ID;
}

/** Inside bb the claude-honcho plugin is off, but global instructions may still name its tools. */
export const TOOLS_NOTE = `Inside bb, Honcho memory is these tools: ${HONCHO_TOOL_NAMES.join(", ")}. The mcp__plugin_honcho_honcho__* tools are switched off here, so don't use them.`;

/** Tools for this resolution: none for codex unless `codexUseBbTools` (codex keeps its own honcho MCP). */
export function selectTools(providerId: string, codexUseBbTools: boolean): string[] {
  return providerId === "codex" && !codexUseBbTools ? [] : [...HONCHO_TOOL_NAMES];
}

/**
 * The only session-build injection point (contributeInstructions is unused).
 * Synchronous; reads the in-memory cache only and schedules refreshes.
 */
export function registerConfigure(bb: BbPluginApi, _deps: RecallDeps, recall: RecallRuntime): void {
  const { shared, cache, settings, deps } = recallInternals(recall);
  bb.agents.configure((ctx): PluginAgentConfiguration => {
    const tools = selectTools(ctx.provider.id, settings.codexUseBbTools());
    let instructions: string | undefined;
    const withNote = (memory?: string): PluginAgentConfiguration => {
      const text = tools.length ? (memory ? `${TOOLS_NOTE}\n\n${memory}` : TOOLS_NOTE) : memory;
      return text ? { tools, skills: [], instructions: text } : { tools, skills: [] };
    };
    try {
      const sideChat = isSideChat(ctx);
      const parentThreadId = ctx.thread.parentThreadId ?? ctx.thread.sourceThreadId;
      const input = {
        threadId: ctx.thread.id, parentThreadId, sideChat,
        projectId: ctx.project.id, environmentId: ctx.environment.id,
        path: ctx.environment.path, projectName: ctx.project.name,
      };
      // Paused or deny-listed threads get no memory; an unknown deny answer fails closed.
      const contextThreadId = ScopeResolver.contextThread(input);
      const blocked = shared.gate.blockedNow({ id: ctx.thread.id, projectId: ctx.project.id, environmentId: ctx.environment.id ?? null, contextThreadId });
      if (blocked !== false) return withNote();
      const { scope, provisional } = shared.scopes.sync(input);
      if (provisional) void shared.scopes.resolve(input).then(s => { if (cache.want(s)) cache.request(true); }, () => undefined);
      if (cache.want(scope)) cache.request(true);
      const snap = cache.snapshot();
      if (snap.lastSuccess === null) { cache.request(true); return withNote(); }
      const entry = snap.scopes.get(scope);
      const marks = shared.store.agentWrittenInScope(scope);
      const byId = new Map(snap.recent.map(c => [c.id, c]));
      const agentNotes = marks.flatMap(m => { const c = byId.get(m.id); return c ? [{ content: c.content, confirmed: m.confirmed }] : []; });
      instructions = buildInstructions({
        peer: snap.peer ?? "user", card: snap.card, scope, scopeSummary: entry?.summary ?? null,
        agentNotes, stale: snap.stale, refreshedAt: snap.lastSuccess,
      });
      if (instructions) {
        deps.activity.record({ kind: "recall", threadId: ctx.thread.id, summary: `session memory injected (scope ${scope}${contextThreadId !== ctx.thread.id ? ", from parent thread" : ""}${snap.stale ? ", stale" : ""})` });
      }
    } catch (error) {
      bb.log.warn(`honcho configure: ${error instanceof Error ? error.name : "error"}`);
      instructions = undefined;
    }
    return withNote(instructions);
  });
}

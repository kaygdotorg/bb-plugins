import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { aiPeer } from "./mapping";
import type { MessageDraft } from "./honcho-client";
import { redact, type RedactionOptions } from "./redact";

export type CaptureEvent = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["events"]["list"]>>[number];
export interface TransformContext {
  userPeer: string; providerId: string;
  /** Accepted ids from adjacent event pages; no message content retained. */
  acceptedRequestIds?: ReadonlySet<string>;
  /** Required for child spawn prompts when no senderThreadId was recorded. */
  parentProviderId?: string;
  senderProviders?: Readonly<Record<string, string>>;
  originPluginId?: string | null;
  workflowChild?: boolean;
  redaction?: RedactionOptions;
}
export interface TransformResult { messages: MessageDraft[]; redactionCount: number; unresolvedSenders: string[]; pendingRequests: Array<{ requestId: string; seq: number }> }
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
function trivialCommand(command: string): boolean {
  // Only discard a command when every simple component is a known read.
  // Quotes, substitutions and redirections need a shell parser; keep them.
  if (/[`$<>]/.test(command)) return false;
  const parts = command.split(/&&|\|\||[;|\n]/).filter(part => part.trim());
  return parts.length > 0 && parts.every(part => /^(?:(?:rtk|command)\s+)?(?:ls|cat|head|tail|grep|rg|pwd|find|wc|stat|readlink|which|read)\b/.test(part.trim()));
}
function ownTool(name: string): boolean { return /(?:^|[^a-z])honcho(?:[^a-z]|$)/i.test(name); }
function toolSummary(item: Record<string, unknown>): string | undefined {
  if (item.type === "commandExecution") {
    const command = typeof item.command === "string" ? item.command : "";
    if (!command || trivialCommand(command) || /^bb\s+honcho\b/.test(command.trim())) return;
    return `ran: ${oneLine(command)}`;
  }
  if (item.type === "fileChange") {
    const paths = Array.isArray(item.changes) ? item.changes.flatMap(c => typeof c?.path === "string" ? [c.path] : []) : [];
    return paths.length ? `edited: ${oneLine(paths.join(", "))}` : undefined;
  }
  if (item.type !== "toolCall" && item.type !== "mcpToolCall") return;
  const tool = typeof item.tool === "string" ? item.tool : "";
  const server = typeof item.server === "string" ? item.server : "";
  if (ownTool(`${server}/${tool}`) || /^(?:read|read_file|list_directory|list_files|glob|grep|search_files|view_image)$/i.test(tool)) return;
  const args = item.arguments && typeof item.arguments === "object" ? item.arguments as Record<string, unknown> : {};
  if (/^(?:exec_command|bash|shell|run_command)$/.test(tool)) {
    const command = args.cmd ?? args.command;
    return typeof command === "string" ? toolSummary({ type: "commandExecution", command }) : `ran: ${server}/${tool}`;
  }
  if (/^(?:write_file|edit_file|edit|write|apply_patch)$/.test(tool)) {
    const path = args.path ?? args.file_path;
    // Raw patches and JSON args are never included.
    return typeof path === "string" ? `edited: ${oneLine(path)}` : `ran: ${server}/${tool}`;
  }
  return tool ? `ran: ${oneLine(server ? `${server}/${tool}` : tool)}` : undefined;
}
/** Pure ordered transformation. client/turn/requested is the canonical prompt
 * source. Provider userMessage echoes are ignored, as are partial deltas.
 * Unresolved inter-thread attribution is reported and withheld, never credited
 * to the user; the caller can resolve providers and retry from its cursor. */
export function transformEvents(events: readonly CaptureEvent[], context: TransformContext): TransformResult {
  const result: TransformResult = { messages: [], redactionCount: 0, unresolvedSenders: [], pendingRequests: [] };
  const accepted = new Set(context.acceptedRequestIds);
  for (const event of events) if (event.type === "turn/input/accepted") accepted.add(event.data.clientRequestId);
  for (const event of events) {
    let content = "", peer = aiPeer(context.providerId), reasoning = false;
    let trigger: string | undefined;
    if (event.type === "client/turn/requested") {
      const data = event.data;
      if (!accepted.has(data.requestId)) { result.pendingRequests.push({ requestId: data.requestId, seq: event.seq }); continue; }
      if (data.initiator === "system" && data.systemMessageKind?.startsWith("child-")) continue;
      content = (data.input ?? []).flatMap(part => part.type === "text" ? [part.text] : []).join("\n");
      const sender = data.senderThreadId ?? content.match(/^\[bb message from thread:([^\]\s]+)\]/)?.[1];
      const parentPrompt = data.source === "spawn" && data.initiator === "agent";
      if (sender || parentPrompt) {
        const provider = sender ? context.senderProviders?.[sender] : context.parentProviderId;
        if (!provider) { result.unresolvedSenders.push(sender ?? "parent"); continue; }
        peer = aiPeer(provider);
      } else {
        peer = context.userPeer;
        reasoning = data.initiator === "user" && !context.workflowChild;
        const automation = content.match(/^\[bb automation due:([^\]]+)\]/);
        if (automation && (data.originPluginId ?? context.originPluginId)) {
          reasoning = false;
          trigger = "automation";
        }
      }
    } else if (event.type === "item/completed") {
      const item = event.data.item;
      if (item.parentToolCallId) continue;
      if (item.type === "agentMessage") content = item.text;
      else content = toolSummary(item as unknown as Record<string, unknown>) ?? "";
    } else continue;
    if (!content) continue;
    const redacted = redact(content, context.redaction);
    result.redactionCount += redacted.count;
    const large = content.length > 25_000;
    let offset = 0, chunk = 0;
    while (offset < redacted.text.length) {
      let end = Math.min(offset + 25_000, redacted.text.length);
      // Do not split a surrogate pair across messages.
      if (end < redacted.text.length && /[\uD800-\uDBFF]/.test(redacted.text[end - 1])) end--;
      result.messages.push({
        peer_id: peer, content: redacted.text.slice(offset, end),
        created_at: new Date(event.createdAt).toISOString(),
        configuration: { reasoning: { enabled: reasoning && !large } },
        metadata: { bb_thread: event.threadId, bb_seq: event.seq, bb_part: chunk++, ...(trigger ? { trigger } : {}) },
      });
      offset = end;
    }
  }
  return result;
}

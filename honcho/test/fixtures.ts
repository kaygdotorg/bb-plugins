import type { CaptureEvent } from "../lib/transform";

type Prompt = Extract<CaptureEvent, { type: "client/turn/requested" }>;
type Completed = Extract<CaptureEvent, { type: "item/completed" }>;
export type Item = Completed["data"]["item"];
/** Synthetic content only. Shapes copied from two live codex/claude logs;
 * no live text, IDs, credentials, filesystem paths, or tool outputs copied. */
const base = (seq: number) => ({ id: `evt_fixture${seq}`, scope: { kind: "thread" as const }, threadId: "thr_fixture", seq, createdAt: 1_700_000_000_000 + seq });
export function prompt(seq: number, text: string, overrides: Partial<Prompt["data"]> = {}): Prompt {
  return { ...base(seq), type: "client/turn/requested", data: {
    direction: "outbound", execution: { model: "fixture-model", serviceTier: "default", reasoningLevel: "medium", permissionMode: "full", source: "client/turn/requested" }, requestId: `creq_fixture${seq}`, source: "spawn", initiator: "user", senderThreadId: null,
    systemMessageKind: "unlabeled", systemMessageSubject: null,
    input: [{ type: "text", text, mentions: [] }], target: { kind: "thread-start" },
    request: { method: "thread/start", params: {} }, ...overrides,
  } };
}
export function completed(seq: number, item: Item): Completed {
  return { ...base(seq), type: "item/completed", data: { providerThreadId: "provider_fixture", item } };
}
export function agent(seq: number, text: string): Completed {
  return completed(seq, { type: "agentMessage", id: `item_${seq}`, text });
}
export function command(seq: number, command: string): Completed {
  return completed(seq, { type: "commandExecution", id: `item_${seq}`, command, cwd: "/synthetic/repo", status: "completed", approvalStatus: null, aggregatedOutput: "synthetic output must never be captured", exitCode: 0 });
}
export function tool(seq: number, name: string, args: Record<string, unknown> = {}, server = "bb"): Completed {
  return completed(seq, { type: "toolCall", id: `item_${seq}`, server, tool: name, arguments: args, status: "completed", result: "synthetic output must never be captured" });
}
export const syntheticThread: CaptureEvent[] = [
  prompt(1, "please test the library"),
  { ...base(2), type: "provider.env-resolved", data: { providerThreadId: "provider_fixture", entries: [{ name: "SYNTHETIC_KEY", value: "never captured", source: "shell" }] } },
  { ...base(3), type: "item/started", data: { providerThreadId: "provider_fixture", item: { type: "agentMessage", id: "item_3", text: "" } } },
  { ...base(4), type: "item/agentMessage/delta", data: { providerThreadId: "provider_fixture", itemId: "item_3", delta: "partial" } },
  agent(5, "i will run the tests"),
  completed(6, { type: "reasoning", id: "item_6", summary: [], content: ["never capture reasoning"] }),
  command(7, "rg test lib"), command(8, "npm test"),
  tool(9, "chat", { query: "never capture memory query" }, "plugin_honcho_honcho"),
  completed(10, { type: "fileChange", id: "item_10", status: "completed", approvalStatus: null, changes: [{ path: "lib/example.ts", kind: "update", diff: "never capture raw diff" }] }),
  agent(11, "tests pass"),
];

import { describe, expect, it } from "vitest";
import { isEditMessage, providerThreadIdOf, transformEvents, type CaptureEvent, type TransformContext } from "../lib/transform";
import { accepted, agent, command, completed, editMessage, identity, prompt, syntheticThread, tool } from "./fixtures";
const context: TransformContext = { userPeer: "hermy", providerId: "codex", senderProviders: { thr_sender: "claude-code" } };
const transform = (events: CaptureEvent[], extra: Partial<TransformContext> = {}) => transformEvents(events, {
  ...context, acceptedRequestIds: new Set(events.flatMap(e => e.type === "client/turn/requested" ? [e.data.requestId] : [])), ...extra,
});

describe("capture", () => {
  it("requires acceptance by matching clientRequestId", () => {
    const requested = prompt(1, "pending");
    expect(transformEvents([requested], context)).toMatchObject({ messages: [], pendingRequests: [{ requestId: "creq_fixture1", seq: 1 }] });
    const accepted: CaptureEvent = { ...requested, seq: 2, type: "turn/input/accepted", data: { providerThreadId: "provider_fixture", clientRequestId: "creq_fixture1" }, scope: { kind: "turn", turnId: "turn_fixture" } };
    expect(transformEvents([requested, accepted], context).messages[0].content).toBe("pending");
    expect(transformEvents([requested, { ...accepted, data: { ...accepted.data, clientRequestId: "wrong" } }], context).messages).toEqual([]);
  });
  it("excludes parentToolCallId on every tool/item type", () => {
    const items = [command(1, "npm test"), tool(2, "external"), completed(3, { type: "fileChange", id: "item", status: "completed", approvalStatus: null, changes: [{ path: "src/x.ts", kind: "update" }] })];
    for (const item of items) item.data.item.parentToolCallId = "parent";
    expect(transform(items).messages).toEqual([]);
  });
  it("captures final full text and one-line tool summaries from real-shaped events", () => {
    const result = transform(syntheticThread);
    expect(result.messages.map(m => m.content)).toEqual(["please test the library", "i will run the tests", "ran: npm test", "edited: lib/example.ts", "tests pass"]);
    expect(result.messages.map(m => m.peer_id)).toEqual(["hermy", "codex", "codex", "codex", "codex"]);
    expect(result.messages.map(m => m.configuration?.reasoning?.enabled)).toEqual([true, false, false, false, false]);
    for (const m of result.messages) {
      expect(m.metadata).toMatchObject({ bb_thread: "thr_fixture", bb_part: 0 });
      expect(m.metadata?.bb_seq).toBeTypeOf("number"); expect(m.created_at).toMatch(/^2023-/);
    }
    expect(JSON.stringify(result)).not.toContain("never capture");
  });
  it("credits senderThreadId and textual thread messages to the sender provider", () => {
    const result = transform([prompt(1, "message", { senderThreadId: "thr_sender", initiator: "agent" }), prompt(2, "[bb message from thread:thr_sender] hello")]);
    expect(result.messages.map(m => m.peer_id)).toEqual(["claude_code", "claude_code"]);
    expect(result.messages.every(m => m.configuration?.reasoning?.enabled === false)).toBe(true);
  });
  it("withholds unresolved senders for caller resolution", () => {
    expect(transform([prompt(1, "[bb message from thread:thr_unknown] message")])).toMatchObject({ messages: [], unresolvedSenders: ["thr_unknown"] });
  });
  it("credits workflow child prompts to parent and disables all child reasoning", () => {
    const result = transform([prompt(1, "child task", { initiator: "agent" }), prompt(2, "user reply"), agent(3, "child answer")], { parentProviderId: "pi", workflowChild: true });
    expect(result.messages.map(m => m.peer_id)).toEqual(["pi", "hermy", "codex"]);
    expect(result.messages.every(m => m.configuration?.reasoning?.enabled === false)).toBe(true);
  });
  it.each(["child-completed", "child-outcome-batch", "child-failed"] as const)("drops system %s messages", kind => {
    expect(transform([prompt(1, "child outcome", { initiator: "system", systemMessageKind: kind })]).messages).toEqual([]);
    expect(transform([prompt(2, "user text", { initiator: "user", systemMessageKind: kind })]).messages).toHaveLength(1);
  });
  it("detects automation only with prefix and origin plugin, leaves user replies normal", () => {
    const result = transform([prompt(1, "[bb automation due:synthetic] prompt", { originPluginId: "automations" }), prompt(2, "reply"), prompt(3, "mentioned [bb automation due:synthetic]", { originPluginId: "automations" })]);
    expect(result.messages[0]).toMatchObject({ peer_id: "hermy", metadata: { trigger: "automation" }, configuration: { reasoning: { enabled: false } } });
    expect(result.messages.slice(1).every(m => m.configuration?.reasoning?.enabled)).toBe(true);
    expect(transform([prompt(1, "[bb automation due:synthetic] text")]).messages[0].metadata?.trigger).toBeUndefined();
  });
  it("drops images, files, parentToolCallId and provider userMessage echoes", () => {
    const subagent = agent(2, "child text"); subagent.data.item.parentToolCallId = "parent_tool";
    const input = prompt(1, "text", { input: [{ type: "text", text: "text", mentions: [] }, { type: "image", url: "https://synthetic.test/image" }, { type: "localFile", path: "/synthetic/file" }] });
    const echo = completed(3, { type: "userMessage", id: "echo", clientRequestId: "creq_fixture1", content: [{ type: "text", text: "text" }] });
    expect(transform([input, subagent, echo]).messages.map(m => m.content)).toEqual(["text"]);
  });
  it("drops standalone diff and image events", () => {
    const events = [{ ...agent(1, ""), type: "turn/diff/updated", data: { diff: "private diff" } }, completed(2, { type: "imageView", id: "image", path: "/synthetic/image" })] as CaptureEvent[];
    expect(transform(events).messages).toEqual([]);
  });
  it.each(["ls -la", "rtk read example.ts", "cat a | grep b", "rg a && pwd", "head a\ntail b"])("drops trivial read %s", cmd => expect(transform([command(1, cmd)]).messages).toEqual([]));
  it("retains mixed read/write commands and normalizes line breaks", () => {
    expect(transform([command(1, "cat a && npm test\necho ok")]).messages[0].content).toBe("ran: cat a && npm test echo ok");
  });
  it.each(["honcho_chat", "mcp__honcho__chat", "honcho_search"])("drops own %s", name => expect(transform([tool(1, name)]).messages).toEqual([]));
  it("handles tools without persisting raw arguments, output or patches", () => {
    const result = transform([tool(1, "exec_command", { cmd: "npm test" }), tool(2, "edit_file", { file_path: "src/x.ts", diff: "private" }), tool(3, "external", { secret: "private" }), tool(4, "read_file"), tool(5, "exec_command", { cmd: "ls" })]);
    expect(result.messages.map(m => m.content)).toEqual(["ran: npm test", "edited: src/x.ts", "ran: bb/external"]);
  });
  it("redacts before splitting, counts matches and turns off large-paste reasoning", () => {
    const text = "x".repeat(24990) + " synthetic-secret " + "y".repeat(26000);
    const result = transform([prompt(10, text)], { redaction: { deny: ["synthetic-secret"] } });
    expect(result.redactionCount).toBe(1); expect(result.messages).toHaveLength(3);
    expect(result.messages.map(m => m.content).join("")).toBe(text.replace("synthetic-secret", "[REDACTED]"));
    expect(result.messages.map(m => m.metadata?.bb_part)).toEqual([0, 1, 2]);
    expect(result.messages.every(m => m.content.length <= 25000 && m.configuration?.reasoning?.enabled === false && m.metadata?.bb_seq === 10)).toBe(true);
  });
  it("preserves surrogate pairs and order at the limit", () => {
    const text = "x".repeat(24999) + "😀" + "z";
    const messages = transform([agent(1, text), agent(2, "next")]).messages;
    expect(messages.map(m => m.content.length)).toEqual([24999, 3, 4]);
    expect(messages.slice(0, 2).map(m => m.content).join("")).toBe(text);
  });
  it("takes the user text from client/turn/requested confirmed by an in-log turn/input/accepted", () => {
    const result = transformEvents(syntheticThread, { userPeer: "hermy", providerId: "codex" });
    expect(result.pendingRequests).toEqual([]);
    expect(result.messages.map(m => [m.peer_id, m.metadata?.bb_seq])).toEqual([["hermy", 1], ["codex", 7], ["codex", 10], ["codex", 12], ["codex", 13]]);
    // The same prompt without its acceptance event stays pending and is not captured.
    expect(transformEvents(syntheticThread.filter(e => e.type !== "turn/input/accepted"), { userPeer: "hermy", providerId: "codex" })).toMatchObject({ messages: expect.not.arrayContaining([expect.objectContaining({ peer_id: "hermy" })]), pendingRequests: [{ requestId: "creq_fixture1", seq: 1 }] });
  });
  it("never credits an agent-initiated prompt to the user", () => {
    const tell = prompt(1, "plain text with no sender", { source: "tell", initiator: "agent" });
    expect(transform([tell])).toMatchObject({ messages: [], unresolvedSenders: ["parent"] });
    expect(transform([tell], { parentProviderId: "claude-code" }).messages.map(m => m.peer_id)).toEqual(["claude_code"]);
  });
  it("ignores delegation, web fetch and reasoning items and does not read userMessage echoes", () => {
    const events = [
      completed(1, { type: "delegation", id: "d", childRef: "thr_child", label: "child", status: "completed", background: false, summary: "never captured" } as never),
      completed(2, { type: "webFetch", id: "w", url: "https://synthetic.test", prompt: "never", pattern: null, resultText: "never" } as never),
      completed(3, { type: "reasoning", id: "r", summary: [], content: ["never"] }),
    ];
    expect(transform(events).messages).toEqual([]);
  });
  it("recognises edit_message operations and thread identities", () => {
    expect(isEditMessage(editMessage(5))).toBe(true);
    expect(isEditMessage({ ...editMessage(5), data: { ...(editMessage(5).data as object), operation: "environment_directory_update" } } as CaptureEvent)).toBe(false);
    expect(isEditMessage(agent(1, "x"))).toBe(false);
    expect(providerThreadIdOf(identity(1, "provider_a"))).toBe("provider_a");
    expect(providerThreadIdOf(accepted(2, "x"))).toBeUndefined();
    expect(transform([editMessage(5), identity(6, "p")]).messages).toEqual([]);
  });
});

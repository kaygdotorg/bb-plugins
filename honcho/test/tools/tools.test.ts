import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { HONCHO_TOOL_NAMES } from "../../lib/tools";
import { setup, seedConclusion, seedMessage, type SetupOptions } from "../recall/harness";

const testing = { createFakePluginHost, experimental_createHostEntryHarness };
const start = (opts: SetupOptions = {}) => setup(testing, opts);
type Setup = Awaited<ReturnType<typeof start>>;
const open: Setup[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });
const make = async (opts: SetupOptions = {}) => { const s = await start(opts); open.push(s); return s; };
const call = (s: Setup, name: string, input: unknown) => s.harness.behavior.callAgentTool(name, input, { threadId: "thr_main" });
const text = (r: PluginAgentToolResult) => typeof r === "string" ? r : r.content.map(c => c.type === "text" ? c.text : "").join("");
const isError = (r: PluginAgentToolResult) => typeof r !== "string" && r.isError === true;

describe("honcho tools", () => {
  it("registers the four tools with zod params and presentation labels", async () => {
    const s = await make();
    const tools = s.harness.registrations.agentTools;
    expect(tools.map(t => t.name).sort()).toEqual([...HONCHO_TOOL_NAMES].sort());
    for (const t of tools) expect(t.presentation?.label?.pending).toBeTruthy();
  });

  it("honcho_chat defaults to the user peer at low reasoning, and supports scope and workspace", async () => {
    const s = await make();
    expect(text(await call(s, "honcho_chat", { query: "what editor?" }))).toContain("synthetic memory");
    await call(s, "honcho_chat", { query: "q", scope: "repo-one", reasoning_level: "medium" });
    await call(s, "honcho_chat", { query: "q", workspace: true });
    const chats = s.mock.requests.filter(r => r.path.endsWith("/chat"));
    expect(chats.map(r => [r.path.replace(/.*workspaces\/test/, ""), r.body.reasoning_level, r.body.scope ?? null])).toEqual([
      ["/peers/hermy/chat", "low", null], ["/peers/hermy/chat", "medium", "repo-one"], ["/chat", "low", null]]);
    expect(isError(await call(s, "honcho_chat", { query: "q", scope: "a", workspace: true }))).toBe(true);
    expect(s.activity.list({ kinds: ["tool"] })).toHaveLength(4);
  });

  it("honcho_search searches the user's messages, or a scope", async () => {
    const s = await make();
    seedMessage(s.mock, { id: "m1", session: "thr_old", scope: "repo-one", content: "we pinned node 22" });
    expect(text(await call(s, "honcho_search", { query: "node 22" }))).toContain("we pinned node 22");
    expect(text(await call(s, "honcho_search", { query: "node 22", scope: "repo-one" }))).toContain("session thr_old");
    expect(text(await call(s, "honcho_search", { query: "node 22", scope: "nope" }))).toContain("No matching messages.");
  });

  it("honcho_conclude saves an explicit conclusion marked agent-written; honcho_conclusions lists, queries, deletes", async () => {
    const s = await make();
    seedConclusion(s.mock, { id: "con_d", content: "likes tea", level: "deductive" });
    const saved = text(await call(s, "honcho_conclude", { content: "prefers zsh" }));
    expect(saved).toMatch(/agent-written conclusion con_\d+/);
    const created = s.mock.conclusions.find(c => c.content === "prefers zsh")!;
    expect(created).toMatchObject({ observer_id: "hermy", observed_id: "hermy", session_id: "thr_main" });
    const listed = text(await call(s, "honcho_conclusions", { action: "list" }));
    expect(listed).toContain(`${created.id} [agent-written, explicit] prefers zsh`);
    expect(listed).toContain("con_d [deductive] likes tea");
    expect(text(await call(s, "honcho_conclusions", { action: "query", query: "tea" }))).toContain("likes tea");
    expect(isError(await call(s, "honcho_conclusions", { action: "query" }))).toBe(true);
    expect(text(await call(s, "honcho_conclusions", { action: "delete", id: created.id }))).toContain("Deleted");
    expect(s.mock.conclusions.some(c => c.id === created.id)).toBe(false);
  });

  it("returns a clear message instead of throwing when Honcho is offline or rejects the key", async () => {
    const s = await make({ offline: true });
    const offline = await call(s, "honcho_search", { query: "x" });
    expect(isError(offline)).toBe(true);
    expect(text(offline)).toContain("Honcho is offline");
    s.state.offline = false;
    s.mock.fault(401);
    const auth = await call(s, "honcho_chat", { query: "x" });
    expect(isError(auth)).toBe(true);
    expect(text(auth)).toContain("rejected the API key");
    expect(s.activity.list({ kinds: ["tool"] }).map(e => e.error)).toEqual(["auth", "offline"]);
  });

  it("restricted key: scope and workspace params explain why, plain calls still work", async () => {
    const s = await make();
    s.mock.fault(403); // key-level probe on scopes/list
    for (const input of [{ query: "x", scope: "repo-one" }, { query: "x", workspace: true }]) {
      const result = await call(s, "honcho_chat", input);
      expect(isError(result)).toBe(true);
      expect(text(result)).toContain("key is restricted");
    }
    expect(isError(await call(s, "honcho_search", { query: "x", workspace: true }))).toBe(true);
    expect(isError(await call(s, "honcho_chat", { query: "x" }))).toBe(false);
    expect(s.mock.requests.filter(r => r.path.endsWith("/scopes/list"))).toHaveLength(1);
  });
});

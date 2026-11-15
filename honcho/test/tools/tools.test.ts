import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import type { PluginAgentToolResult } from "@get-bb/plugin-sdk";
import { HonchoError } from "../../lib/honcho-client";
import { HONCHO_TOOL_NAMES } from "../../lib/tools";
import { setup, seedConclusion, seedMessage, type SetupOptions } from "../recall/harness";

/** A synthetic thread the tools can look up when they create its session. */
const threadSdk = (extra: Record<string, unknown> = {}) => ({
  threads: { get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "proj_1", environmentId: "env_1", providerId: "claude-code", parentThreadId: null, sourceThreadId: null, originKind: null, originPluginId: null }) },
  environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_a", path: "/synthetic/plain", isGitRepo: false }) },
  projects: { get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: "Repo One", gitRemoteUrl: null }) },
  ...extra,
});

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
    expect(listed).toContain("con_d [learned from the user, deductive] likes tea");
    expect(text(await call(s, "honcho_conclusions", { action: "query", query: "tea" }))).toContain("likes tea");
    expect(isError(await call(s, "honcho_conclusions", { action: "query" }))).toBe(true);
    expect(text(await call(s, "honcho_conclusions", { action: "delete", id: created.id }))).toContain("deleted");
    expect(s.mock.conclusions.some(c => c.id === created.id)).toBe(false);
  });

  it("a chat timeout says Honcho was slow, not offline", async () => {
    const s = await make();
    const slow = new HonchoError("timeout", undefined, undefined, 60_000);
    s.client.peerChat = async () => { throw slow; };
    const r = await call(s, "honcho_chat", { query: "x" });
    expect(isError(r)).toBe(true);
    expect(text(r)).toContain("Honcho took too long to answer (60 s); try again or use honcho_search");
    expect(text(r)).not.toContain("offline");
    expect(s.activity.list({ kinds: ["tool"] }).map(e => e.error)).toEqual(["timeout"]);
  });

  it("deleting a conclusion that is already gone reports success", async () => {
    const s = await make();
    s.mock.fault(404);
    const r = await call(s, "honcho_conclusions", { action: "delete", id: "con_gone" });
    expect(isError(r)).toBe(false);
    expect(text(r)).toContain("already gone");
  });

  it("forget deletes nothing: it lists candidates, and only explicit ids get deleted (live incident 2026-11-15)", async () => {
    const cards: string[][] = [["Has a cat TESTER-Biscuit"], []];
    const s = await make({ ports: { peerCard: async () => cards.shift() ?? [] } });
    await call(s, "honcho_conclude", { content: "user's cat is TESTER-Biscuit" });
    seedConclusion(s.mock, { id: "con_derived", content: "The user's cat is called TESTER-Biscuit", level: "explicit" });
    seedConclusion(s.mock, { id: "con_tea", content: "likes tea" });
    await s.internals.cache.refresh();
    const before = s.mock.conclusions.length;
    const r = await call(s, "honcho_conclusions", { action: "forget", query: "cat" });
    expect(isError(r)).toBe(false);
    expect(text(r)).toContain("Nothing was deleted");
    expect(text(r)).toContain("con_derived");
    expect(s.mock.conclusions.length).toBe(before); // a semantic match alone never deletes
    expect(s.mock.requests.some(q => q.method === "DELETE")).toBe(false);
    const own = s.mock.conclusions.find(c => c.content.includes("user's cat"))!;
    const d = await call(s, "honcho_conclusions", { action: "delete", ids: [own.id, "con_derived"] });
    expect(text(d)).toContain(`${own.id}: deleted`);
    expect(s.mock.conclusions.map(c => c.id)).toEqual(["con_tea"]);
    expect(s.internals.cache.snapshot().card).toEqual([]); // memory refreshed after the delete
    expect(isError(await call(s, "honcho_conclusions", { action: "delete" }))).toBe(true);
    await expect(call(s, "honcho_conclusions", { action: "delete", ids: Array.from({ length: 11 }, (_, i) => `c${i}`) })).rejects.toThrow(/<=10/); // schema caps a delete at 10 ids
    expect(isError(await call(s, "honcho_conclusions", { action: "forget" }))).toBe(true);
  });

  it("labels the deriver's own explicit conclusions learned, and only honcho_conclude's as agent-written", async () => {
    const s = await make();
    seedConclusion(s.mock, { id: "con_x", content: "likes tea", level: "explicit" });
    await call(s, "honcho_conclude", { content: "prefers zsh" });
    const listed = text(await call(s, "honcho_conclusions", { action: "list" }));
    expect(listed).toContain("con_x [learned from the user, explicit] likes tea");
    expect(listed).toMatch(/\[agent-written, explicit\] prefers zsh/);
  });

  it("describes whose memory it is and tells agents to summarise and to use forget", async () => {
    const s = await make();
    const d = (n: string) => s.harness.registrations.agentTools.find(t => t.name === n)!.description;
    for (const n of ["honcho_search", "honcho_chat"]) { expect(d(n)).toContain("bb owner"); expect(d(n)).toMatch(/[Ss]ummarise/); }
    expect(d("honcho_search")).toContain("raw search hits");
    expect(d("honcho_conclusions")).toContain("`forget`");
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

  it("honcho_conclude redacts secrets before saving and refuses when nothing is left", async () => {
    const s = await make({ ports: { secretValues: () => ["hunter2-synthetic"] } });
    const saved = text(await call(s, "honcho_conclude", { content: "deploy password is hunter2-synthetic, use staging" }));
    expect(saved).toContain("1 secret was redacted");
    expect(s.mock.conclusions.at(-1)!.content).toBe("deploy password is [REDACTED], use staging");
    const before = s.mock.conclusions.length;
    expect(isError(await call(s, "honcho_conclude", { content: "hunter2-synthetic" }))).toBe(true);
    expect(s.mock.conclusions).toHaveLength(before);
  });

  it("honcho_conclude creates a missing session as capture would, then attaches the conclusion to it", async () => {
    const s = await make({ sdk: threadSdk() });
    s.mock.fault(404); // the thread's session does not exist yet
    const saved = await call(s, "honcho_conclude", { content: "prefers tabs" });
    expect(isError(saved)).toBe(false);
    const session = s.mock.requests.find(r => r.method === "POST" && /\/sessions$/.test(r.path))!;
    expect(session.body).toMatchObject({
      id: "thr_main", scopes: ["repo-one"],
      peers: { claude_code: { observe_me: false, observe_others: false }, hermy: { observe_me: true, observe_others: false } },
      metadata: { provider: "claude-code", host: "host_a", environment: "env_1", project: "proj_1" },
    });
    const created = s.mock.conclusions.filter(c => c.content === "prefers tabs");
    expect(created).toHaveLength(1);
    expect(created[0].session_id).toBe("thr_main");
    expect(s.recall.conclusionsForThread("thr_main")).toEqual([{ id: created[0].id, attached: true }]);
  });

  it("honcho_conclude in a deny-listed thread never creates a session: saved unattached and recorded for the delete path", async () => {
    const s = await make({ sdk: threadSdk(), ports: { isDenied: async () => true } });
    s.mock.fault(404);
    expect(isError(await call(s, "honcho_conclude", { content: "likes vim" }))).toBe(false);
    expect(s.mock.requests.some(r => r.method === "POST" && /\/sessions$/.test(r.path))).toBe(false);
    const created = s.mock.conclusions.find(c => c.content === "likes vim")!;
    expect(created.session_id).toBeUndefined();
    expect(s.recall.conclusionsForThread("thr_main")).toEqual([{ id: created.id, attached: false }]);
  });

  it("honcho_conclude reports success with the id when only the local mark fails", async () => {
    const s = await make();
    s.internals.shared.store.markAgentWritten = () => { throw new Error("disk full"); };
    const saved = await call(s, "honcho_conclude", { content: "uses fish" });
    expect(isError(saved)).toBe(false);
    const created = s.mock.conclusions.find(c => c.content === "uses fish")!;
    expect(text(saved)).toContain(created.id);
    expect(s.activity.list({ kinds: ["failure"] })[0]).toMatchObject({ threadId: "thr_main", error: "Error" });
  });
});

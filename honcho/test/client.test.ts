import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HonchoClient, HonchoError, seqRange, type MessageDraft } from "../lib/honcho-client";
import { mockHoncho } from "./mock-honcho";
let mock: Awaited<ReturnType<typeof mockHoncho>>, client: HonchoClient;
beforeEach(async () => { mock = await mockHoncho(); client = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test", apiKey: "synthetic-key" }); });
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); await mock.close(); });
const draft: MessageDraft = { content: "hello fixture", peer_id: "hermy", created_at: "2026-01-02T00:00:00.000Z", metadata: { bb_thread: "thread", bb_seq: 1, bb_part: 0 }, configuration: { reasoning: { enabled: true } } };
describe("v3 REST client", () => {
  it("gets or creates workspace, peer and session with metadata and config", async () => {
    const workspace = await client.getOrCreateWorkspace({ source: "bb" }, { reasoning: { enabled: true } });
    expect(workspace.id).toBe("test"); expect((await client.getOrCreateWorkspace()).uid).toBe(workspace.uid);
    const peer = await client.getOrCreatePeer("codex", { source: "bb" }); expect(peer.metadata).toEqual({ source: "bb" });
    const session = await client.getOrCreateSession("thread", { metadata: { provider: "codex" }, peers: { hermy: { observe_me: true }, codex: { observe_me: false } }, scopes: ["repo"] });
    expect(session.metadata).toEqual({ provider: "codex" });
    expect(await client.addPeers("thread", { pi: { observe_me: false, observe_others: true } })).toMatchObject({ id: "thread", peers: { pi: { observe_me: false, observe_others: true } } });
    expect(mock.requests[0]).toMatchObject({ method: "POST", path: "/v3/workspaces", body: { id: "test", metadata: { source: "bb" } } });
  });
  it("sends message config, timestamps, metadata filters and pagination verbatim", async () => {
    const messages = await client.createMessages("thread", [draft, { ...draft, metadata: { bb_seq: 2, bb_thread: "thread" } }]);
    expect(messages[0]).toMatchObject(draft);
    const page = await client.listMessages("thread", { bb_thread: "thread" }, { size: 1, page: 1 });
    expect(page.items).toHaveLength(1); expect(page).toMatchObject({ page: 1, pages: 2, total: 2 });
    const next = await client.listMessages("thread", { bb_thread: "thread" }, { size: 1, page: 2 }); expect(next.items[0].metadata?.bb_seq).toBe(2);
    expect((await client.listMessages("thread", { bb_seq: 99 })).items).toEqual([]);
    expect(mock.requests[1]).toEqual({ method: "POST", path: "/v3/workspaces/test/sessions/thread/messages/list", query: { size: "1", page: "1" }, body: { filters: { metadata: { bb_thread: "thread" } } } });
  });
  it("lists every message across pages, not just the first 100", async () => {
    for (let start = 0; start < 250; start += 100) {
      await client.createMessages("big", Array.from({ length: Math.min(100, 250 - start) }, (_, i) => ({ ...draft, content: `m${start + i}`, metadata: { bb_seq: start + i } })));
    }
    const all = await client.listAllMessages("big");
    expect(all).toHaveLength(250); expect(all[249]!.content).toBe("m249");
    expect(await client.listAllMessages("big", {}, 120)).toHaveLength(120);
  });
  it("filters messages by bb_seq ranges and follows pages", async () => {
    await client.createMessages("thread", [1, 2, 3, 4, 5].map(n => ({ ...draft, content: `m${n}`, metadata: { bb_thread: "thread", bb_seq: n, bb_part: 0 } })));
    const range = await client.listMessages("thread", { bb_thread: "thread", ...seqRange(2, 4) });
    expect(range.items.map(m => m.metadata?.bb_seq)).toEqual([2, 3, 4]);
    expect(mock.requests.at(-1)?.body).toEqual({ filters: { metadata: { bb_thread: "thread", bb_seq: { gte: 2, lte: 4 } } } });
    expect((await client.listMessages("thread", seqRange(4))).items).toHaveLength(2);
    expect((await client.listMessages("thread", seqRange(undefined, 1))).items).toHaveLength(1);
    expect((await client.listAllMessages("thread", { bb_thread: "thread" })).map(m => m.content)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    expect(await client.listAllMessages("thread", seqRange(2), 2)).toHaveLength(2);
    expect(seqRange(3, 3)).toEqual({ bb_seq: { gte: 3, lte: 3 } });
  });
  it("creates a session with peers, scopes and metadata in one call", async () => {
    const session = await client.getOrCreateSession("thread", { metadata: { provider: "codex" }, scopes: ["repo"], peers: { hermy: { observe_me: true, observe_others: false }, codex: { observe_me: false, observe_others: false } } });
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]).toMatchObject({ method: "POST", path: "/v3/workspaces/test/sessions", body: { id: "thread", scopes: ["repo"], peers: { codex: { observe_me: false } } } });
    expect(session).toMatchObject({ scopes: ["repo"] });
    // The session is in its scope before any message exists.
    expect(mock.scopes.get("test/repo")).toEqual(new Set(["thread"]));
    for (const bad of ["bad id", "", "x".repeat(513)]) expect(() => client.getOrCreateSession(bad)).toThrow(HonchoError);
    expect(() => client.getOrCreateSession("thread", { scopes: ["Bad Scope"] })).toThrow(HonchoError);
  });
  it("accepts limits and rejects invalid batches without issuing HTTP", async () => {
    await client.createMessages("thread", Array.from({ length: 100 }, () => ({ ...draft, content: "x".repeat(25000) })));
    const count = mock.requests.length;
    for (const batch of [[], Array.from({ length: 101 }, () => draft), [{ ...draft, content: "x".repeat(25001) }]]) {
      expect(() => client.createMessages("thread", batch)).toThrow(HonchoError);
    }
    expect(mock.requests).toHaveLength(count);
  });
  it("searches workspace, session and peer, using filters and scope", async () => {
    await client.createMessages("thread", [draft, { ...draft, peer_id: "codex", content: "other" }]);
    await client.addSessionToScope("repo", "thread");
    expect(await client.searchWorkspace({ query: "hello", scope: "repo", limit: 2 })).toHaveLength(1);
    expect(await client.searchWorkspace({ query: "hello", scope: "empty" })).toEqual([]);
    expect(await client.searchSession("thread", { query: "hello", filters: { peer_id: "hermy" } })).toHaveLength(1);
    expect(await client.searchPeer("codex", { query: "other" })).toHaveLength(1);
    expect(mock.scopes.get("test/repo")).toEqual(new Set(["thread"]));
  });
  it("uses nonstreaming scoped peer/workspace chat and low reasoning by default", async () => {
    expect(await client.peerChat("hermy", { query: "preferences", scope: "repo" })).toEqual({ content: "synthetic memory" });
    await client.workspaceChat({ query: "preferences", scope: ["repo"], reasoning_level: "medium" });
    expect(mock.requests[0].body).toEqual({ query: "preferences", scope: "repo", reasoning_level: "low", stream: false });
    expect(mock.requests[1].body.reasoning_level).toBe("medium");
    await client.peerChat("hermy", { query: "preferences", filters: { session_id: { in: ["thread", "side"] } }, target: "hermy" });
    expect(() => client.peerChat("hermy", { query: "q", scope: "repo", session_id: "thread" })).toThrow();
    expect(() => client.workspaceChat({ query: "q", scope: "repo", session_id: "thread" })).toThrow();
  });
  it("creates, lists, queries and deletes conclusions", async () => {
    const created = await client.createConclusions([{ content: "agent-written: uses fixtures", observer_id: "codex", observed_id: "hermy", session_id: "thread" }]);
    expect(created).toHaveLength(1);
    expect((await client.listConclusions({ observed: "hermy" }, { size: 10 })).items).toEqual(created);
    expect(await client.queryConclusions({ query: "fixtures", top_k: 3, filters: { observer: "codex", observed: "hermy" } })).toEqual(created);
    await client.deleteConclusion(created[0].id); expect((await client.listConclusions()).items).toEqual([]);
    expect(() => client.createConclusions([])).toThrow(HonchoError);
  });
  it("lists conclusions by session, observer and observed, and sends ids as the SDK does", async () => {
    await client.createConclusions([
      { content: "a fixtures", observer_id: "codex", observed_id: "hermy", session_id: "s1" },
      { content: "b fixtures", observer_id: "hermy", observed_id: "hermy", session_id: "s2" },
      { content: "c fixtures", observer_id: "hermy", observed_id: "hermy" },
    ]);
    expect((await client.listConclusions({ session_id: "s1" })).items.map(c => c.content)).toEqual(["a fixtures"]);
    expect(mock.requests.at(-1)?.body).toEqual({ filters: { session_id: "s1" } });
    expect((await client.listConclusions({ observer: "hermy", observed: "hermy" })).items).toHaveLength(2);
    expect(mock.requests.at(-1)?.body).toEqual({ filters: { observer_id: "hermy", observed_id: "hermy" } });
    const [derived] = await client.listConclusions({ session_id: "s2" }).then(p => p.items);
    mock.conclusions.push({ id: "d1", content: "derived", observer_id: "hermy", observed_id: "hermy", level: "deductive", source_ids: [derived.id] });
    expect((await client.listConclusions({ source_ids: { contains: derived.id } })).items.map(c => c.id)).toEqual(["d1"]);
    const found = await client.queryConclusions({ query: "fixtures", filters: { observer: "hermy", observed: "hermy", session_id: "s2" } });
    expect(found.map(c => c.content)).toEqual(["b fixtures"]);
    expect(mock.requests.at(-1)?.body).toEqual({ query: "fixtures", filters: { observer_id: "hermy", observed_id: "hermy", session_id: "s2" } });
    for (const filters of [{}, { observer: "hermy" }, { observed: "hermy" }]) expect(() => client.queryConclusions({ query: "q", filters: filters as never })).toThrow(HonchoError);
    expect(() => client.queryConclusions({ query: "q", top_k: 101, filters: { observer: "a", observed: "b" } })).toThrow(HonchoError);
  });
  it("updates message metadata and reads scoped representations", async () => {
    const [message] = await client.createMessages("thread", [draft]);
    const metadata = { ...message.metadata, bb_superseded: true };
    expect(await client.updateMessageMetadata("thread", message.id, metadata)).toMatchObject({ metadata });
    expect(mock.requests.at(-1)).toMatchObject({ method: "PUT", body: { metadata } });
    expect(await client.peerRepresentation("hermy", { scope: "repo" })).toEqual({ representation: "synthetic representation for repo" });
    expect(mock.requests.at(-1)).toMatchObject({ method: "POST", path: "/v3/workspaces/test/peers/hermy/representation", body: { scope: "repo" } });
    expect((await client.peerRepresentation("hermy", { scope: ["repo", "other"], max_conclusions: 10 })).representation).toContain("repo,other");
    expect(() => client.peerRepresentation("hermy", { scope: "repo", session_id: "thread" })).toThrow(HonchoError);
    await expect(client.updateMessageMetadata("thread", "missing", {})).rejects.toMatchObject({ kind: "http", status: 404 });
    expect(() => client.queryConclusions({ query: "q", filters: {} as never })).toThrow(HonchoError);
    expect(() => client.getOrCreatePeer("codex", {}, { observe_me: false } as never)).toThrow(HonchoError);
  });
  it("deletes a session using only the documented endpoint", async () => {
    await client.getOrCreateSession("thread"); await client.createMessages("thread", [draft]); await client.deleteSession("thread");
    expect(mock.messages).toEqual([]); expect(mock.requests.at(-1)).toMatchObject({ method: "DELETE", query: {}, path: "/v3/workspaces/test/sessions/thread" });
  });
  it("probes broad capability read-only and treats narrower access conservatively", async () => {
    expect(await client.probeKeyLevel()).toBe("workspace-or-admin");
    mock.fault(403); expect(await client.probeKeyLevel()).toBe("restricted");
    mock.fault(401); await expect(client.probeKeyLevel()).rejects.toMatchObject({ kind: "auth" });
    expect(mock.requests.every(r => r.path.endsWith("/scopes/list"))).toBe(true);
  });
  it.each([[401, "auth"], [403, "auth"], [429, "rate-limited"], [400, "validation"], [422, "validation"], [404, "http"]])("classifies HTTP %s without retries or echoed secrets", async (status, kind) => {
    mock.fault(status as number, "synthetic-key", { "retry-after": "15" });
    let error: any; try { await client.searchWorkspace({ query: "q" }); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ kind, status, retryAfter: "15" }); expect(String(error)).not.toContain("synthetic-key"); expect(mock.requests).toHaveLength(1);
  });
  it("retries 5xx once", async () => {
    mock.fault(503); expect(await client.searchWorkspace({ query: "q" })).toEqual([]); expect(mock.requests).toHaveLength(2);
  });
  it("returns a safe typed error after two 5xx responses", async () => {
    mock.fault(500, "synthetic-key"); mock.fault(502, "synthetic-key");
    await expect(client.searchWorkspace({ query: "q" })).rejects.toMatchObject({ kind: "server", status: 502 }); expect(mock.requests).toHaveLength(2);
  });
  it("retries network errors once and masks fetch diagnostics", async () => {
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic-key in URL"));
    const offline = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test", fetch: transport });
    await expect(offline.getOrCreateWorkspace()).rejects.toMatchObject({ kind: "offline", message: "Honcho offline." }); expect(transport).toHaveBeenCalledTimes(2);
    transport.mockReset().mockRejectedValueOnce(new TypeError("network")).mockResolvedValueOnce(new Response("[]"));
    expect(await offline.searchWorkspace({ query: "q" })).toEqual([]);
  });
  it("applies an 8-second timeout per attempt without wall-clock assertions", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await client.searchWorkspace({ query: "q" }); expect(timeout).toHaveBeenCalledWith(8000);
  });
  it("gives a scoped representation 30 s", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await client.peerRepresentation("hermy", { scope: "repo" });
    expect(timeout).toHaveBeenLastCalledWith(30_000);
  });
  it("gives chat 60 s and reports a timeout as its own kind, never offline, without retrying", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await client.peerChat("peer", { query: "q" }); expect(timeout).toHaveBeenLastCalledWith(60_000);
    await client.workspaceChat({ query: "q" }); expect(timeout).toHaveBeenLastCalledWith(60_000);
    await client.searchPeer("peer", { query: "q" }); expect(timeout).toHaveBeenLastCalledWith(8000);
    await client.listConclusions(); expect(timeout).toHaveBeenLastCalledWith(8000);
    await client.peerRepresentation("peer"); expect(timeout).toHaveBeenLastCalledWith(30_000);
    const slow = vi.fn<typeof fetch>().mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    const c = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test", fetch: slow });
    await expect(c.peerChat("peer", { query: "q" })).rejects.toMatchObject({ kind: "timeout", timeoutMs: 60_000 });
    expect(slow).toHaveBeenCalledTimes(1);
  });
  it("treats a 404 on conclusion delete as already gone", async () => {
    mock.fault(404);
    expect(await client.deleteConclusion("con_missing")).toBe("gone");
    mock.fault(500); mock.fault(500);
    await expect(client.deleteConclusion("con_x")).rejects.toMatchObject({ kind: "server" });
  });
  it("disables redirects, encodes IDs, and handles invalid response JSON safely", async () => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("[]"));
    const local = new HonchoClient({ baseUrl: `${mock.baseUrl}/v3/`, workspace: "space / name", fetch: transport });
    await local.searchSession("thread / id", { query: "q" });
    expect(transport.mock.calls[0][0]).toContain("/v3/workspaces/space%20%2F%20name/sessions/thread%20%2F%20id/search");
    expect(transport.mock.calls[0][1]?.redirect).toBe("error");
    transport.mockResolvedValue(new Response("synthetic-key"));
    await expect(local.searchWorkspace({ query: "q" })).rejects.toMatchObject({ kind: "validation" });
  });
  it("rejects unsafe base URLs without including them in errors", () => {
    for (const baseUrl of ["https://user:synthetic-key@example.test", "file:///tmp/example", "https://example.test?key=synthetic-key"]) expect(() => new HonchoClient({ baseUrl, workspace: "test" })).toThrow("Honcho validation.");
  });
});

describe("retry safety", () => {
  it("never retries createMessages or createConclusions after a 5xx or a network error", async () => {
    const draft = { content: "x", peer_id: "p" };
    const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 502 }));
    const c = new HonchoClient({ baseUrl: "http://honcho.test", workspace: "w", fetch: transport });
    await expect(c.createMessages("s", [draft])).rejects.toMatchObject({ kind: "server", status: 502 });
    await expect(c.createConclusions([{ content: "c", observer_id: "a", observed_id: "b" }])).rejects.toMatchObject({ kind: "server" });
    expect(transport).toHaveBeenCalledTimes(2);
    transport.mockReset().mockRejectedValue(new TypeError("network"));
    await expect(c.createMessages("s", [draft])).rejects.toMatchObject({ kind: "offline" });
    await expect(c.createConclusions([{ content: "c", observer_id: "a", observed_id: "b" }])).rejects.toMatchObject({ kind: "offline" });
    expect(transport).toHaveBeenCalledTimes(2);
  });
});

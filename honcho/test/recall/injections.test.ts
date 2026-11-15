import { afterEach, describe, expect, it } from "vitest";
import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { setup, seedMessage, type SetupOptions } from "./harness";
import { normalizePromptText, promptHash } from "../../lib/recall/cache-file";

const h = (text: string) => promptHash(normalizePromptText(text));
const testing = { createFakePluginHost, experimental_createHostEntryHarness };
const start = (opts: SetupOptions = {}) => setup(testing, opts);
type Setup = Awaited<ReturnType<typeof start>>;
const open: Setup[] = [];
afterEach(async () => { for (const s of open.splice(0)) await s.close(); });
const make = async (opts: SetupOptions = {}) => {
  const s = await start({ sdk: { threads: { get: async ({ threadId }: { threadId: string }) => ({ title: threadId === "thr_old" ? " Deploy work " : null }) } }, ...opts });
  open.push(s);
  return s;
};

const dispatchCtx = (text: string) => makeMessageDispatchHookContext({
  thread: { id: "thr_main", parentThreadId: null, sourceThreadId: null, originKind: null, originPluginId: null },
  project: { name: "Repo One" }, environment: null, host: { id: "host_a" },
  input: { text, blocks: [] }, requestedExecution: { providerId: "claude-code" }, initiator: "user",
});
async function dispatch(s: Setup, text: string) {
  s.harness.registrations.hooks["message.dispatch"]!(dispatchCtx(text));
  await s.prefetch.idle();
}
/** What the hook writes after it injected a hit. */
const serve = (s: Setup, text: string, counter: number, at: number, thread = "thr_main") =>
  appendFile(join(s.recallDir, `${thread}.served.jsonl`), JSON.stringify({ v: 1, hash: h(text), counter, at }) + "\n");

describe("recall.injections (per-turn)", () => {
  it("joins served notes to the stored excerpts, with date, source thread and title", async () => {
    const s = await make();
    seedMessage(s.mock, { id: "m1", session: "thr_old", scope: "repo-one", content: "how do we deploy the api to staging" });
    await dispatch(s, "deploy the api to staging");
    await dispatch(s, "nothing matches this zzz");
    expect(await s.recall.injections({ threadId: "thr_main" })).toEqual([]); // nothing served yet
    await serve(s, "deploy the api to staging", 1, 5_000);
    const got = await s.recall.injections({ threadId: "thr_main" });
    expect(got).toEqual([{
      kind: "turn", at: 5_000, scope: "repo-one",
      items: [{ content: "how do we deploy the api to staging", date: "2026-10-01", sourceThreadId: "thr_old", sourceTitle: "Deploy work" }],
    }]);
    expect(JSON.stringify(got)).not.toContain("honcho_memory");
    expect(await s.recall.injections({ threadId: "thr_main", since: 6_000 })).toEqual([]);
  });

  it("never joins a note to an empty match (no record is kept), and ignores unknown notes", async () => {
    const s = await make();
    await dispatch(s, "no results for this");
    await serve(s, "no results for this", 1, 10);
    await serve(s, "never dispatched", 7, 11);
    expect(await s.recall.injections({ threadId: "thr_main" })).toEqual([]);
  });

  it("sourceTitle is null when the thread is unknown", async () => {
    const s = await make({ sdk: { threads: { get: async () => { throw new Error("404"); } } } });
    seedMessage(s.mock, { id: "m1", session: "thr_gone", scope: "repo-one", content: "release notes draft" });
    await dispatch(s, "release notes");
    await serve(s, "release notes", 1, 20);
    const [turn] = await s.recall.injections({ threadId: "thr_main" });
    expect(turn.items[0]).toMatchObject({ sourceThreadId: "thr_gone", sourceTitle: null });
  });

  it("thread.deleted removes the records and the served file", async () => {
    const s = await make();
    seedMessage(s.mock, { id: "m1", session: "thr_old", scope: "repo-one", content: "how do we deploy the api" });
    await dispatch(s, "deploy the api");
    await serve(s, "deploy the api", 1, 30);
    expect(await readdir(s.recallDir)).toEqual(["thr_main.json", "thr_main.served.jsonl"]);
    expect(s.internals.shared.store.turnInjection("thr_main", h("deploy the api"), 1)).not.toBeNull();
    await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_main" }) });
    await s.prefetch.idle();
    expect(await readdir(s.recallDir)).toEqual([]);
    expect(s.internals.shared.store.turnInjection("thr_main", h("deploy the api"), 1)).toBeNull();
    expect(await s.recall.injections({ threadId: "thr_main" })).toEqual([]);
  });
});

describe("recall.injections (session)", () => {
  const cfg = (s: Setup) => s.harness.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({
    thread: { id: "thr_main", parentThreadId: null, sourceThreadId: null },
    project: { name: "My Project" }, environment: { path: null }, provider: { id: "claude-code" },
  }));

  it("records the card lines only when memory was actually injected", async () => {
    const s = await make({ ports: { peerCard: async () => ["Name: Sam", "INSTRUCTION: dates as YYYY-MM-DD"] } });
    await cfg(s); // before the first refresh: nothing injected
    expect(await s.recall.injections({ threadId: "thr_main" })).toEqual([]);
    await s.internals.cache.refresh();
    const before = Date.now();
    await cfg(s);
    const [session, ...rest] = await s.recall.injections({ threadId: "thr_main" });
    expect(rest).toEqual([]);
    expect(session).toMatchObject({ kind: "session", scope: "my-project", items: [] });
    expect(session.at).toBeGreaterThanOrEqual(before);
    expect(session.card).toEqual(expect.arrayContaining(["Name: Sam", "directive: dates as YYYY-MM-DD"]));
  });

  it("records nothing for a paused thread, which gets no memory", async () => {
    const s = await make({ ports: { peerCard: async () => ["Name: Sam"] } });
    await cfg(s);
    await s.internals.cache.refresh();
    s.deps.outbox.setPaused("thread", "thr_main", true, 0);
    await cfg(s);
    expect(await s.recall.injections({ threadId: "thr_main" })).toEqual([]);
  });

  it("thread.deleted removes session injections", async () => {
    const s = await make({ ports: { peerCard: async () => ["Name: Sam"] } });
    await cfg(s);
    await s.internals.cache.refresh();
    await cfg(s);
    await s.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_main" }) });
    await s.prefetch.idle();
    expect(await s.recall.injections({ threadId: "thr_main" })).toEqual([]);
  });
});

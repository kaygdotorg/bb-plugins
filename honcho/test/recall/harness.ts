import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import hostEntry from "../../host";
import { RingActivityLog } from "../../lib/activity";
import type { Deps } from "../../lib/contract";
import { HonchoClient, HonchoError } from "../../lib/honcho-client";
import { createRecallService, registerConfigure, registerDispatchPrefetch, type RecallPorts } from "../../lib/recall";
import { recallInternals } from "../../lib/recall/service";
import { registerTools } from "../../lib/tools";
import { mockHoncho } from "../mock-honcho";
import { openOutbox } from "../../lib/outbox";

export const PEER = "hermy";
export const WORKSPACE = "test";

/* eslint-disable @typescript-eslint/no-explicit-any */
type FakeHostFactory = (options: any) => { bb: BbPluginApi; harness: { lifecycle: { dispose(): Promise<void> } } };
type HostHarnessFactory = (entry: any, options: any) => { experimental_call(method: any, input: any): Promise<any>; experimental_dispose(): Promise<void> };
export interface TestingSdk<F extends FakeHostFactory, H extends HostHarnessFactory> { createFakePluginHost: F; experimental_createHostEntryHarness: H }
export type SetupOptions = { settings?: Record<string, boolean | number | string>; ports?: RecallPorts; offline?: boolean; sdk?: Record<string, unknown> };

/** Fake bb host + mock Honcho + the real host entry, routed through the fake host-RPC driver.
 * The testing SDK is passed in: only *.test.ts files may import it (package scan). */
export async function setup<F extends FakeHostFactory, H extends HostHarnessFactory>(sdk: TestingSdk<F, H>, opts: SetupOptions = {}) {
  const { createFakePluginHost, experimental_createHostEntryHarness } = sdk;
  const mock = await mockHoncho();
  const dataDir = await mkdtemp(join(tmpdir(), "honcho-recall-"));
  const host = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(dataDir, "tmp") } }) as ReturnType<H>;
  const fake = createFakePluginHost({
    pluginId: "honcho", settings: opts.settings, sdk: opts.sdk,
    experimental_callHostRpc: ({ method, input }: { method: string; input: unknown }) => host.experimental_call(method, input),
  }) as ReturnType<F>;
  const bb: BbPluginApi = fake.bb;
  const harness: ReturnType<F>["harness"] = fake.harness;
  const activity = new RingActivityLog();
  const state = { offline: opts.offline ?? false };
  const client = new HonchoClient({ baseUrl: mock.baseUrl, workspace: WORKSPACE });
  const deps: Deps = {
    config: async () => ({ config: { baseUrl: mock.baseUrl, apiKey: "", workspace: WORKSPACE, peerName: PEER }, keys: [], warnings: [] }),
    client: async () => { if (state.offline) throw new HonchoError("offline"); return client; },
    outbox: openOutbox(bb.storage),
    activity,
  };
  const recall = createRecallService(bb, { ...deps, recall: opts.ports });
  registerConfigure(bb, deps, recall);
  const prefetch = registerDispatchPrefetch(bb, deps, recall);
  registerTools(bb, deps);
  const internals = recallInternals(recall);
  return {
    mock, bb, harness, host, dataDir, activity, deps, recall, prefetch, internals, state, client,
    recallDir: join(dataDir, "recall"),
    async close() {
      internals.cache.cancel();
      await harness.lifecycle.dispose();
      await host.experimental_dispose();
      await mock.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

/** Seed one conversation message in a session that belongs to a scope. */
export function seedMessage(mock: Awaited<ReturnType<typeof mockHoncho>>, row: { id: string; session: string; scope?: string; peer?: string; content: string; metadata?: Record<string, unknown> }) {
  mock.messages.push({ id: row.id, content: row.content, peer_id: row.peer ?? PEER, session_id: row.session, workspace_id: WORKSPACE, created_at: "2026-10-01T00:00:00.000Z", token_count: 1, metadata: row.metadata ?? {} });
  if (row.scope) {
    const key = `${WORKSPACE}/${row.scope}`;
    mock.scopes.set(key, (mock.scopes.get(key) ?? new Set()).add(row.session));
  }
}
export function seedConclusion(mock: Awaited<ReturnType<typeof mockHoncho>>, row: { id: string; content: string; level?: string; session?: string }) {
  mock.conclusions.push({ id: row.id, content: row.content, observer_id: PEER, observed_id: PEER, created_at: "2026-10-01T00:00:00.000Z", level: row.level ?? "deductive", ...(row.session ? { session_id: row.session } : {}) });
}

/** A synthetic linked worktree: its .git file points into the main repo's .git/worktrees. */
export const WORKTREE = "/synthetic/wt/feature-x";
export function worktreeSdk() {
  const files: Record<string, string> = {
    [`${WORKTREE}/.git`]: "gitdir: /synthetic/src/Cool.Repo/.git/worktrees/feature-x\n",
    "/synthetic/src/Cool.Repo/.git/worktrees/feature-x/commondir": "../..\n",
    "/synthetic/src/Cool.Repo/.git/config": "[remote \"origin\"]\n\turl = git@example.test:acme/cool-repo.git\n",
  };
  return {
    environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_a", path: WORKTREE, isGitRepo: true }) },
    projects: { get: async ({ projectId }: { projectId: string }) => ({ id: projectId, name: "Repo One", gitRemoteUrl: null }) },
    files: { read: async ({ path }: { path: string }) => {
      if (!(path in files)) throw Object.assign(new Error("not found"), { status: 404 });
      return { content: files[path], contentEncoding: "utf8" };
    } },
  };
}

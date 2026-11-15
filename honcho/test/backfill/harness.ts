import type { BbPluginApi } from "@get-bb/plugin-sdk";
type CreateHost = (options: { pluginId: string; sdk: never }) => { bb: BbPluginApi; harness: { lifecycle: { dispose(): Promise<void> } } };
import { HonchoClient } from "../../lib/honcho-client";
import { openOutbox } from "../../lib/outbox";
import { createBackfillService } from "../../lib/backfill";
import type { BackfillDeps } from "../../lib/backfill";
import type { ActivityEntry } from "../../lib/contract";
import type { CaptureEvent } from "../../lib/transform";
import { agent, prompt } from "../fixtures";
import { mockHoncho } from "../mock-honcho";

export const T0 = 1_700_000_000_000;
export interface FakeThread { id: string; providerId: string; cwd?: string; providerThreadIds?: string[]; events: CaptureEvent[]; archived?: boolean; projectId?: string; createdAt?: number }

/** One accepted prompt + one agent reply, 2 events per turn at seq (2n+1, 2n+2) ... */
export function turn(threadId: string, n: number, text: string, at = T0 + n * 60_000, reply = `reply to ${text}`): CaptureEvent[] {
  const seq = n * 3 + 1;
  const base = { threadId, createdAt: at };
  const request = { ...prompt(seq, text, { requestId: `creq_${threadId}_${n}` }), ...base, seq };
  const accepted = { ...request, id: `evt_${threadId}_a${n}`, seq: seq + 1, type: "turn/input/accepted", scope: { kind: "turn", turnId: `turn_${n}` }, data: { providerThreadId: "provider_fixture", clientRequestId: `creq_${threadId}_${n}` } } as unknown as CaptureEvent;
  const answer = { ...agent(seq + 2, reply), ...base, seq: seq + 2 };
  return [request, accepted, answer];
}
export const identity = (threadId: string, providerThreadId: string, seq = 0): CaptureEvent =>
  ({ id: `evt_${threadId}_id${seq}`, scope: { kind: "thread" }, threadId, seq, createdAt: T0, type: "thread/identity", data: { providerThreadId } }) as unknown as CaptureEvent;

export async function setup(createFakePluginHost: CreateHost, threads: FakeThread[], extra: Partial<BackfillDeps> = {}) {
  const mock = await mockHoncho();
  const client = new HonchoClient({ baseUrl: mock.baseUrl, workspace: "test", apiKey: "synthetic-key" });
  const summaries = threads.map((t, i) => ({
    id: t.id, providerId: t.providerId, projectId: t.projectId ?? "proj_a", environmentPath: t.cwd ?? null, environmentId: "env_1", environmentHostId: "host_1",
    createdAt: t.createdAt ?? T0 + i, updatedAt: Math.max(T0, ...t.events.map(e => e.createdAt)), archivedAt: t.archived ? T0 : null, deletedAt: null, originPluginId: null, parentThreadId: null, originKind: null,
  }));
  const events = (t: FakeThread) => [...(t.providerThreadIds ?? []).map((id, i) => identity(t.id, id, 1000 + i)), ...t.events].sort((a, b) => a.seq - b.seq);
  const { bb, harness } = createFakePluginHost({ pluginId: "honcho", sdk: {
    threads: {
      list: async (args: { offset?: number; limit?: number; archived?: boolean } = {}) => summaries.filter(s => args.archived === false ? !s.archivedAt : true).slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50)),
      get: async ({ threadId }: { threadId: string }) => summaries.find(s => s.id === threadId),
      events: { list: async (args: { threadId: string; afterSeq?: string; limit?: string; types?: string[] }) => {
        const thread = threads.find(t => t.id === args.threadId)!;
        return events(thread).filter(e => e.seq > Number(args.afterSeq ?? -1) && (!args.types || args.types.includes(e.type))).slice(0, Number(args.limit ?? 100));
      } },
    },
  } as never });
  const outbox = openOutbox(bb.storage);
  const activity: ActivityEntry[] = [];
  const deps: BackfillDeps = {
    config: async () => ({ config: { baseUrl: mock.baseUrl, apiKey: "synthetic-key", workspace: "test", peerName: "hermy" }, keys: ["synthetic-key"], warnings: [] }),
    client: async () => client, outbox,
    activity: { record: e => { activity.push({ ...e, id: activity.length + 1, at: 0 }); }, list: () => activity, subscribe: () => () => {} },
    messagesPerMinute: () => 6000, sleep: async () => {},
    ...extra,
  };
  const service = createBackfillService(bb, deps);
  return { mock, client, bb, outbox, activity, service, deps, db: bb.storage.database(), async close() { await harness.lifecycle.dispose(); await mock.close(); } };
}

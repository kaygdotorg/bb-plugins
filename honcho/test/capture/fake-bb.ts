// Fake bb for capture tests: lifecycle events, an events.list backed by
// synthetic per-thread logs, a manual clock, and a real in-memory sqlite db.
// Synthetic content only; no live ids, paths or credentials.
import Database from "better-sqlite3";
import type { ActivityEntry, ActivityLog } from "../../lib/contract";
import { HonchoClient } from "../../lib/honcho-client";
import { Outbox } from "../../lib/outbox";
import type { CaptureEvent } from "../../lib/transform";
import type { CaptureBb, CaptureDeps, Clock } from "../../lib/capture/ports";

export class FakeClock implements Clock {
  t = 1_800_000_000_000;
  private timers: Array<{ id: number; at: number; fn: () => void }> = [];
  private next = 1;
  now() { return this.t; }
  setTimeout(fn: () => void, ms: number) { const id = this.next++; this.timers.push({ id, at: this.t + ms, fn }); return id; }
  clearTimeout(handle: unknown) { this.timers = this.timers.filter(t => t.id !== handle); }
  /** Moves time forward, firing due timers in order. */
  advance(ms: number) {
    const target = this.t + ms;
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at);
      const due = this.timers[0];
      if (!due || due.at > target) break;
      this.timers.shift();
      this.t = Math.max(this.t, due.at);
      due.fn();
    }
    this.t = target;
  }
}

type Row = Record<string, any>;
export interface FakeThread {
  id: string; providerId: string; projectId: string; environmentId: string | null;
  originKind: "fork" | null; originPluginId: string | null; parentThreadId: string | null; sourceThreadId: string | null;
  createdAt: number; deletedAt: number | null; archivedAt: number | null; visibility: "visible" | "hidden";
}

export function fakeBb(clock: FakeClock) {
  const handlers = new Map<string, Array<(p: any) => unknown>>();
  const threads = new Map<string, FakeThread>();
  const logs = new Map<string, CaptureEvent[]>();
  const seqs = new Map<string, number>();
  const kv = new Map<string, unknown>();
  const db = new Database(":memory:");
  const listCalls: Row[] = [];
  let ids = 0;

  const addThread = (id: string, over: Partial<FakeThread> = {}): FakeThread => {
    const thread: FakeThread = { id, providerId: "claude-code", projectId: "proj_fixture", environmentId: "env_fixture", originKind: null, originPluginId: null,
      parentThreadId: null, sourceThreadId: null, createdAt: clock.now(), deletedAt: null, archivedAt: null, visibility: "visible", ...over };
    threads.set(id, thread);
    logs.set(id, logs.get(id) ?? []);
    return thread;
  };
  const append = (threadId: string, type: string, data: Row, at = clock.now()): CaptureEvent => {
    const seq = (seqs.get(threadId) ?? 0) + 1;
    seqs.set(threadId, seq);
    const event = { id: `evt_${++ids}`, seq, type, createdAt: at, threadId, scope: { kind: "thread" }, data } as unknown as CaptureEvent;
    logs.get(threadId)!.push(event);
    return event;
  };
  const prompt = (threadId: string, text: string, over: Row = {}) => {
    const requestId = `creq_${++ids}`;
    const e = append(threadId, "client/turn/requested", { requestId, initiator: "user", source: "tell", senderThreadId: null, systemMessageKind: "unlabeled",
      input: [{ type: "text", text, mentions: [] }], execution: { model: "fixture-model" }, ...over });
    append(threadId, "turn/input/accepted", { clientRequestId: requestId, providerThreadId: "prov_fixture" });
    return e.seq;
  };
  const agent = (threadId: string, text: string) => append(threadId, "item/completed", { providerThreadId: "prov_fixture", item: { type: "agentMessage", id: `item_${++ids}`, text } }).seq;
  const turnDone = (threadId: string) => append(threadId, "turn/completed", { status: "completed", providerThreadId: "prov_fixture" }).seq;
  const envResolved = (threadId: string, names: string[]) => append(threadId, "provider.env-resolved", {
    providerThreadId: "prov_fixture", entries: names.map(name => ({ name, source: "shell", value: { masked: true } })) }).seq;
  const identity = (threadId: string, providerThreadId: string) => append(threadId, "thread/identity", { providerThreadId }).seq;
  /** bb's edit: delete [cutoff, oldMax], then append the operation event. */
  const edit = (threadId: string, cutoff: number) => {
    const log = logs.get(threadId)!;
    const oldMax = seqs.get(threadId)!;
    const op = append(threadId, "system/operation", { operation: "edit_message", status: "completed", message: "Message edited", operationId: `op_${++ids}`,
      metadata: { cutoffSequence: cutoff, oldMaxSequence: oldMax } });
    logs.set(threadId, log.filter(e => e.seq < cutoff || e.seq === op.seq));
    return op.seq;
  };

  const notFound = () => Object.assign(new Error("not found"), { status: 404 });
  const bb = {
    events: { on(name: string, fn: (p: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); } },
    storage: {
      database: () => db,
      kv: {
        async get(key: string) { return kv.get(key) as any; },
        async set(key: string, value: unknown) { kv.set(key, value); },
        async delete(key: string) { kv.delete(key); },
        async list(prefix = "") { return [...kv.keys()].filter(k => k.startsWith(prefix)); },
      },
    },
    log: { info() {}, warn() {}, error() {} },
    sdk: {
      threads: {
        async get({ threadId }: { threadId: string }) {
          const t = threads.get(threadId);
          if (!t || t.deletedAt !== null) throw notFound();
          return { ...t };
        },
        async list(args: Row = {}) {
          // Like bb: deleted threads are left out, and threadIds limits the rows to those ids.
          const all = [...threads.values()].filter(t => t.deletedAt === null && (args.archived !== false || t.archivedAt === null)
            && (!args.threadIds || args.threadIds.includes(t.id)));
          return all.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 100));
        },
        events: {
          async list(args: Row) {
            // Real bb rejects pages above 100 (HTTP 400 "Thread event limit cannot exceed 100").
            if (Number(args.limit ?? 0) > 100) throw new Error("Thread event limit cannot exceed 100");
            listCalls.push(args);
            let rows = [...(logs.get(args.threadId) ?? [])];
            if (args.types) rows = rows.filter(e => args.types.includes(e.type));
            if (args.afterSeq !== undefined) rows = rows.filter(e => e.seq > Number(args.afterSeq));
            if (args.beforeSeq !== undefined) rows = rows.filter(e => e.seq < Number(args.beforeSeq));
            if (args.order === "desc") rows.reverse();
            return rows.slice(0, args.limit ? Number(args.limit) : 100);
          },
        },
      },
      environments: { async get({ environmentId }: { environmentId: string }) {
        return { id: environmentId, hostId: "host_fixture", path: "/synthetic/work/fixture-repo", isGitRepo: true, projectId: "proj_fixture" };
      } },
      projects: { async get({ projectId }: { projectId: string }) { return { id: projectId, name: "Fixture Project", gitRemoteUrl: null }; } },
      files: { async read(): Promise<never> { throw notFound(); } },
    },
  } as unknown as CaptureBb;

  return {
    bb, db, kv, threads, logs, listCalls, addThread, append, prompt, agent, turnDone, envResolved, identity, edit,
    async emit(name: string, payload: unknown) { for (const fn of handlers.get(name) ?? []) await fn(payload); },
    deleteThread(id: string) { threads.get(id)!.deletedAt = clock.now(); },
  };
}

export function memoryActivity(): ActivityLog & { entries: ActivityEntry[] } {
  const entries: ActivityEntry[] = [];
  let id = 0;
  return {
    entries,
    record(entry) { entries.push({ ...entry, id: ++id, at: 0 }); },
    list() { return [...entries]; },
    subscribe() { return () => undefined; },
  };
}

export function captureDeps(baseUrl: string, db: Database.Database, clock: FakeClock, over: Partial<CaptureDeps> = {}): CaptureDeps & { activity: ReturnType<typeof memoryActivity> } {
  const config = { baseUrl, apiKey: "", workspace: "test", peerName: "hermy" };
  return {
    config: async () => ({ config, keys: [], warnings: [] }),
    client: async () => new HonchoClient({ baseUrl, workspace: "test" }),
    outbox: new Outbox(db),
    activity: memoryActivity(),
    clock, random: () => 0.5,
    git: async () => ({ commonDir: "/synthetic/work/fixture-repo/.git", remote: "git@example.test:acme/fixture-repo.git" }),
    settings: () => ({ captureRequiresSwitchover: false }),
    ...over,
  } as CaptureDeps & { activity: ReturnType<typeof memoryActivity> };
}

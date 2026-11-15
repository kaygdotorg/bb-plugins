import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { BackfillPlan, BackfillService } from "../contract";
import { HonchoError, type MessageDraft } from "../honcho-client";
import { scopeSlug, sessionMetadata, sessionPeers } from "../mapping";
import { transformEvents, type CaptureEvent, type TransformContext } from "../transform";
import { redact } from "../redact";
import { claudeSessionName, codexChatInstanceName, codexPerDirectoryName, TimeIndex } from "./dedupe";
import { honchoPort, type BackfillDeps, type HonchoPort, type ThreadSummary } from "./ports";
import { defaultSleep, RateLimiter } from "./rate";
import { BackfillStore } from "./state";

export type { BackfillDeps, HonchoPort } from "./ports";
export { honchoPort } from "./ports";
export { RateLimiter } from "./rate";
export * from "./dedupe";

export interface BackfillOptions { projectId?: string; since?: string; includeArchived?: boolean; includeHidden?: boolean }
export type BackfillHandle = BackfillService & {
  dryRun(opts?: BackfillOptions): Promise<BackfillPlan>;
  start(opts?: BackfillOptions): Promise<void>;
  /** Resolves when the current run (if any) has finished or been stopped. */
  whenIdle(): Promise<void>;
};

const DEFAULT_RATE = 300;
const BATCH = 100;
const EVENT_PAGE = 500;
const THREAD_PAGE = 200;
const EVENT_TYPES = ["client/turn/requested", "turn/input/accepted", "item/completed"] as const;

interface ScanResult {
  messages: MessageDraft[]; skipped: number; redactions: number;
  /** Cursor to store once everything in `messages` is uploaded. */
  finalCursor: number;
}
const empty = (finalCursor = 0): ScanResult => ({ messages: [], skipped: 0, redactions: 0, finalCursor });

export function createBackfillService(bb: BbPluginApi, deps: BackfillDeps): BackfillHandle {
  const store = new BackfillStore(bb.storage.database());
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(now, deps.sleep ?? defaultSleep);
  const sleep = deps.sleep ?? defaultSleep;
  const state = { running: false, done: 0, total: 0, error: undefined as string | undefined };
  let controller: AbortController | null = null;
  let task: Promise<void> = Promise.resolve();

  const honcho = async (): Promise<HonchoPort> => deps.honcho ? deps.honcho() : honchoPort(await deps.client());

  async function listThreads(opts: BackfillOptions): Promise<ThreadSummary[]> {
    const out: ThreadSummary[] = [];
    const since = opts.since ? Date.parse(opts.since) : NaN;
    for (let offset = 0; ; offset += THREAD_PAGE) {
      const page = await bb.sdk.threads.list({
        includeHidden: opts.includeHidden ?? true, limit: THREAD_PAGE, offset,
        ...(opts.includeArchived ? {} : { archived: false }),
        ...(opts.projectId ? { projectId: opts.projectId } : {}),
      });
      out.push(...page);
      if (page.length < THREAD_PAGE) break;
    }
    return out
      .filter(t => !t.deletedAt && (opts.includeArchived || !t.archivedAt) && (!opts.projectId || t.projectId === opts.projectId))
      .filter(t => Number.isNaN(since) || t.updatedAt >= since)
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  async function readEvents(threadId: string, afterSeq: number, beforeSeq: number | undefined, types: readonly [string, ...string[]]): Promise<CaptureEvent[]> {
    const out: CaptureEvent[] = [];
    for (let after = afterSeq; ;) {
      const page = await bb.sdk.threads.events.list({
        threadId, afterSeq: String(after), limit: String(EVENT_PAGE), order: "asc",
        types: types as never,
      }) as CaptureEvent[];
      let reachedMarker = false;
      for (const event of page) {
        if (beforeSeq !== undefined && event.seq >= beforeSeq) { reachedMarker = true; break; }
        out.push(event);
      }
      if (reachedMarker || page.length < EVENT_PAGE) return out;
      after = page[page.length - 1].seq;
    }
  }

  async function providerOf(threadId: string | null | undefined): Promise<string | undefined> {
    if (!threadId) return undefined;
    try { return (await bb.sdk.threads.get({ threadId } as never) as { providerId?: string }).providerId; } catch { return undefined; }
  }

  // Per-run caches of Honcho lookups keyed by session name.
  interface Caches { exists: Map<string, boolean>; directory: Map<string, TimeIndex> }
  const newCaches = (): Caches => ({ exists: new Map(), directory: new Map() });

  async function scanThread(port: HonchoPort, thread: ThreadSummary, opts: BackfillOptions, caches: Caches): Promise<ScanResult> {
    if (deps.outbox.isPaused(thread.id, thread.projectId)) return empty(); // never upload a paused thread
    if (await deps.isDenied?.(thread)) return empty();
    const cursor = store.cursor(thread.id);
    const marker = deps.outbox.switchOver(thread.id); // live capture owns events from here on
    if (marker !== undefined && cursor >= marker - 1) return empty(cursor);
    const events = await readEvents(thread.id, cursor, marker, EVENT_TYPES);
    const identities = (await readEvents(thread.id, 0, undefined, ["thread/identity"])) as Array<CaptureEvent & { type: "thread/identity" }>;
    const providerThreadIds = [...new Set(identities.map(e => e.data.providerThreadId).filter(Boolean))];
    if (events.length === 0) return empty(marker !== undefined ? marker - 1 : cursor);

    const config = await deps.config();
    const extra = await deps.redaction?.();
    const redaction = { patterns: extra?.patterns, deny: [...config.keys, ...(extra?.deny ?? [])] };
    const base: TransformContext = {
      userPeer: config.config.peerName, providerId: thread.providerId, redaction,
      originPluginId: thread.originPluginId,
    };
    let result = transformEvents(events, base);
    if (result.unresolvedSenders.length) {
      const senderProviders: Record<string, string> = {};
      let parentProviderId: string | undefined;
      for (const sender of new Set(result.unresolvedSenders)) {
        const provider = await providerOf(sender === "parent" ? thread.parentThreadId : sender);
        if (!provider) continue;
        if (sender === "parent") parentProviderId = provider; else senderProviders[sender] = provider;
      }
      result = transformEvents(events, { ...base, senderProviders, parentProviderId });
    }
    const lastSeq = events[events.length - 1].seq;
    const pendingFloor = result.pendingRequests.length ? Math.min(...result.pendingRequests.map(p => p.seq)) - 1 : undefined;
    let finalCursor = marker !== undefined ? marker - 1 : lastSeq;
    if (pendingFloor !== undefined && marker === undefined) finalCursor = Math.max(cursor, Math.min(finalCursor, pendingFloor));

    const since = opts.since ? Date.parse(opts.since) : NaN;
    let messages = result.messages.filter(m => Number.isNaN(since) || Date.parse(m.created_at!) >= since);
    let skipped = 0;
    const skip = (keep: MessageDraft[]) => { skipped += messages.length - keep.length; messages = keep; };

    // 1. Whole-thread match by harness session id.
    const hasSession = async (name: string): Promise<boolean> => {
      let known = caches.exists.get(name);
      if (known === undefined) { known = await port.sessionHasMessages(name); caches.exists.set(name, known); }
      return known;
    };
    const cwd = thread.environmentPath ?? undefined;
    let wholeThread = false;
    if (thread.providerId === "claude-code") {
      for (const id of providerThreadIds) { const name = claudeSessionName(id); if (name && await hasSession(name)) { wholeThread = true; break; } }
    } else if (thread.providerId === "codex" && cwd) {
      for (const id of providerThreadIds) if (await hasSession(codexChatInstanceName(cwd, id))) { wholeThread = true; break; }
    }
    if (wholeThread) { skip([]); return { messages, skipped, redactions: 0, finalCursor }; }

    // 2. Already uploaded by this plugin (live capture or an earlier backfill run).
    if (messages.length) {
      const own = await port.listMessages(thread.id, { bb_thread: thread.id });
      if (own.length) {
        const keys = new Set(own.map(m => `${m.metadata?.bb_seq}:${m.metadata?.bb_part ?? 0}`));
        skip(messages.filter(m => !keys.has(`${m.metadata!.bb_seq}:${m.metadata!.bb_part}`)));
      }
    }

    // 3. Codex per-directory session: one session, many chats; compare text + time.
    if (messages.length && thread.providerId === "codex" && cwd) {
      const name = codexPerDirectoryName(cwd);
      let index = caches.directory.get(name);
      if (!index) {
        index = new TimeIndex();
        for (const m of await port.listMessages(name)) index.add(redact(m.content, redaction).text, Date.parse(m.created_at));
        caches.directory.set(name, index);
      }
      skip(messages.filter(m => !index!.has(m.content, Date.parse(m.created_at!))));
    }
    const redactions = result.redactionCount;
    return { messages, skipped, redactions, finalCursor };
  }

  const plan = async (opts: BackfillOptions, signal?: AbortSignal): Promise<BackfillPlan> => {
    const port = await honcho();
    const caches = newCaches();
    const out: BackfillPlan = { threads: 0, messages: 0, tokens: 0, skippedAlreadyInHoncho: 0, reasoningMessages: 0 };
    for (const thread of await listThreads(opts)) {
      if (signal?.aborted) break;
      const scan = await scanThread(port, thread, opts, caches);
      out.skippedAlreadyInHoncho += scan.skipped;
      if (!scan.messages.length) continue;
      out.threads++;
      out.messages += scan.messages.length;
      out.tokens += Math.ceil(scan.messages.reduce((n, m) => n + m.content.length, 0) / 4);
      out.reasoningMessages += scan.messages.filter(m => m.configuration?.reasoning?.enabled).length;
    }
    return out;
  };

  async function rate(): Promise<number> {
    const value = Number(await deps.messagesPerMinute?.());
    return Number.isFinite(value) && value >= 1 ? Math.min(value, 6000) : DEFAULT_RATE;
  }

  function batches(messages: MessageDraft[]): Array<{ messages: MessageDraft[]; cursorAfter?: number }> {
    const groups = new Map<number, MessageDraft[]>();
    for (const m of messages) { const seq = m.metadata!.bb_seq as number; (groups.get(seq) ?? groups.set(seq, []).get(seq)!).push(m); }
    const out: Array<{ messages: MessageDraft[]; cursorAfter?: number }> = [];
    let current: MessageDraft[] = [], currentSeq = 0;
    const flush = () => { if (current.length) out.push({ messages: current, cursorAfter: currentSeq }); current = []; };
    for (const [seq, group] of groups) {
      if (group.length > BATCH) { // a pathological multi-part event: advance only after its last part
        flush();
        for (let i = 0; i < group.length; i += BATCH) out.push({ messages: group.slice(i, i + BATCH), ...(i + BATCH >= group.length ? { cursorAfter: seq } : {}) });
        continue;
      }
      if (current.length + group.length > BATCH) flush();
      current.push(...group); currentSeq = seq;
    }
    flush();
    return out;
  }

  async function upload(port: HonchoPort, thread: ThreadSummary, scan: ScanResult, signal: AbortSignal): Promise<boolean> {
    const config = await deps.config();
    if (scan.messages.length) {
      const scope = scopeSlug(await deps.scopeFor?.(thread) ?? thread.projectId);
      const providers = [...new Set(scan.messages.map(m => m.peer_id).filter(p => p !== config.config.peerName))];
      await port.ensureSession(thread.id, {
        metadata: sessionMetadata({ provider: thread.providerId, host: thread.environmentHostId, environment: thread.environmentId, project: thread.projectId, parentThread: thread.parentThreadId, origin: thread.originKind }),
        peers: sessionPeers(config.config.peerName, providers.length ? providers : [thread.providerId]),
        scopes: [scope],
      });
    }
    for (const batch of batches(scan.messages)) {
      if (signal.aborted) return false;
      await limiter.take(batch.messages.length, await rate(), signal);
      if (signal.aborted) return false;
      for (let attempt = 0; ; attempt++) {
        try { await port.createMessages(thread.id, batch.messages); break; } catch (error) {
          if (!(error instanceof HonchoError) || error.kind !== "rate-limited" || attempt >= 3) throw error;
          await sleep(Math.min(300, Number(error.retryAfter ?? 60)) * 1000, signal);
          if (signal.aborted) return false;
        }
      }
      if (batch.cursorAfter !== undefined) store.advance(thread.id, batch.cursorAfter, batch.messages.length, now());
      else store.advance(thread.id, store.cursor(thread.id), batch.messages.length, now());
      state.done += batch.messages.length;
      store.updateRun(state.done, state.total);
    }
    store.advance(thread.id, scan.finalCursor, 0, now());
    return true;
  }

  async function run(opts: BackfillOptions, signal: AbortSignal): Promise<void> {
    let failedThreads = 0;
    try {
      const port = await honcho();
      const caches = newCaches();
      const threads = await listThreads(opts);
      // Pass 1: size the run so progress has a stable denominator.
      for (const thread of threads) {
        if (signal.aborted) return;
        try { state.total += (await scanThread(port, thread, opts, caches)).messages.length; } catch (error) { if (error instanceof HonchoError) throw error; }
      }
      store.updateRun(state.done, state.total);
      deps.activity.record({ kind: "backfill", summary: `backfill started: ${threads.length} threads, ${state.total} messages`, messages: state.total });
      // Pass 2: upload, one thread at a time, in thread order.
      for (const thread of threads) {
        if (signal.aborted) break;
        try {
          const scan = await scanThread(port, thread, opts, caches);
          if (!(await upload(port, thread, scan, signal))) break;
          if (scan.messages.length || scan.skipped) deps.activity.record({
            kind: "backfill", threadId: thread.id, messages: scan.messages.length, redactions: scan.redactions,
            summary: `backfilled ${scan.messages.length} messages${scan.skipped ? `, ${scan.skipped} already in honcho` : ""}`,
          });
        } catch (error) {
          if (error instanceof HonchoError) throw error;
          failedThreads++;
          deps.activity.record({ kind: "failure", threadId: thread.id, summary: "backfill skipped a thread after an error", error: "thread" });
        }
      }
      if (failedThreads) state.error = `${failedThreads} thread(s) failed`;
    } catch (error) {
      state.error = error instanceof HonchoError ? error.kind : "error";
      deps.activity.record({ kind: "failure", summary: `backfill stopped: ${state.error}`, error: state.error });
    }
  }

  return {
    dryRun: opts => plan(opts ?? {}), // reads Honcho and bb, writes nothing
    async start(opts = {}) {
      if (state.running) return;
      controller = new AbortController();
      const signal = controller.signal;
      Object.assign(state, { running: true, done: 0, total: 0, error: undefined });
      store.beginRun(now());
      task = run(opts, signal).finally(() => {
        state.running = false;
        store.updateRun(state.done, state.total);
        store.finishRun(now(), state.error);
        if (signal.aborted) deps.activity.record({ kind: "backfill", summary: `backfill stopped at ${state.done}/${state.total} messages`, messages: state.done });
        else if (!state.error) deps.activity.record({ kind: "backfill", summary: `backfill finished: ${state.done} messages`, messages: state.done });
      });
    },
    async progress() {
      if (state.running) return { running: true, done: state.done, total: state.total, ...(state.error ? { error: state.error } : {}) };
      const row = store.run();
      return { running: false, done: row.done, total: row.total, ...(row.error ? { error: row.error } : {}) };
    },
    async stop() { controller?.abort(); await task; },
    whenIdle: () => task,
  };
}

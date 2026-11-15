// Capture: bb thread event log -> Honcho sessions. See DESIGN.md "Capture" and
// "Privacy and deletion". Nothing here blocks a turn: every bb notification only
// schedules work, and uploads run on timers after the grace window.

import { basename } from "node:path";
import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import type { CaptureService, PrivacySettings, ThreadMemoryStatus } from "../contract.js";
import { HonchoError, seqRange, type Conclusion, type HonchoClient, type MessageDraft, type PeerConfig } from "../honcho-client.js";
import { sessionMetadata } from "../mapping.js";
import type { InFlight, RetryError } from "../outbox.js";
import { readPrivacy, recordProviderSeen, resolvePeer } from "../rpc-server.js";
import { isEditMessage, providerThreadIdOf, transformEvents, type CaptureEvent, type TransformContext, type TransformResult } from "../transform.js";
import { sessionHasMessages, sessionMessages, systemClock, type CaptureBb, type CaptureDeps } from "./ports.js";
import { captureCursorStart } from "./switchover.js";
import { scopeKey, threadFacts, type ThreadRef } from "./scope.js";

type Thread = PluginThreadEventPayloads["thread.created"]["thread"];
type EventType = CaptureEvent["type"];

/** Only the types capture looks at; bb never returns deltas, usage or diffs here. */
const READ_TYPES = ["client/turn/requested", "turn/input/accepted", "client/turn/rejected", "item/completed", "turn/completed",
  "system/operation", "thread/identity", "provider.env-resolved"] as const satisfies readonly EventType[];
const GATE_TYPES = ["provider.env-resolved", "turn/completed", "thread/identity"] as const satisfies readonly EventType[];
const PAGE = 500;
const BATCH = 100;
/** Purge-on-delete scans at most this many pages of 100 derived conclusions: Honcho can't filter by source id. */
const PURGE_SCAN_PAGES = 50;
/** A prompt that never got turn/input/accepted stops holding the cursor back after this. */
const STALE_PENDING_MS = 10 * 60_000;
export const SWITCHOVER_ENV = "BB_HONCHO";
export const NOT_SWITCHED_OVER = "harness capture still active until the session rebuilds";

const KV = {
  tripwireChecked: (t: string) => `capture:tripwire-checked:${t}`,
  tripwire: "capture:tripwire",
  pendingDelete: (t: string) => `capture:pending-delete:${t}`,
  pendingDeletePrefix: "capture:pending-delete:",
};

interface ThreadState {
  id: string;
  thread?: Thread;
  timer?: unknown;
  timerAt?: number;
  running?: Promise<void>;
  again: boolean;
  lastUploadAt: number | null;
  queued: number;
  oldestPendingAt: number | null;
  blocked: string | null;
  sessionReady: boolean;
  peers: Set<string>;
  gateScanSeq: number;
  lastTurnCompleted: number;
  editsDone: Set<number>;
}

const data = (e: CaptureEvent) => e.data as unknown as Record<string, unknown>;
const seqOf = (m: MessageDraft) => Number(m.metadata?.bb_seq);
const partOf = (m: MessageDraft) => Number(m.metadata?.bb_part ?? 0);
const isNotFound = (e: unknown) => (e as { status?: number } | null)?.status === 404 || (e as { code?: string } | null)?.code === "thread_not_found";
/** claude-honcho's sanitizeForSessionName / getSessionName. */
export const sanitizeSessionName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
/** The switch-over gate is always open for providers that have no harness hooks to turn off. */
export const gateAlwaysOpen = (providerId: string) => providerId === "pi" || /^acp(?:[-:_]|$)/.test(providerId);

function semaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(resolve => waiting.push(resolve));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}

/** Batches of at most 100 messages, cut only between events: one event's parts
 * stay together (a single event with more than 100 parts is posted in chunks). */
function batches(messages: MessageDraft[]): MessageDraft[][] {
  const out: MessageDraft[][] = [];
  let current: MessageDraft[] = [];
  for (let i = 0; i < messages.length;) {
    let j = i;
    while (j < messages.length && seqOf(messages[j]) === seqOf(messages[i])) j++;
    if (current.length && current.length + (j - i) > BATCH) { out.push(current); current = []; }
    current.push(...messages.slice(i, j));
    i = j;
  }
  if (current.length) out.push(current);
  return out;
}
const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / BATCH) }, (_, i) => items.slice(i * BATCH, (i + 1) * BATCH));

export type CaptureHandle = CaptureService & {
  start(): () => void;
  /** The plugin's one scope resolver and cache; backfill and recall use it too. */
  scopeFor(thread: ThreadRef): Promise<string>;
  /** The scope already resolved for a thread in this load, synchronously (recall's configure reads it). */
  knownScope(threadId: string): string | null;
  /** True when the privacy deny list covers the thread. */
  isDenied(thread: ThreadRef): Promise<boolean>;
};

export function createCaptureService(bb: CaptureBb, deps: CaptureDeps): CaptureHandle {
  const outbox = deps.outbox;
  const clock = deps.clock ?? systemClock;
  const random = deps.random ?? Math.random;
  const grace = deps.graceMs ?? 30_000;
  const facts = threadFacts(bb, deps.git);
  const firstStartedAt = outbox.recordFirstStart(clock.now());
  const limit = semaphore(deps.concurrency ?? 4);
  const states = new Map<string, ThreadState>();
  const deleted = new Set<string>();
  const providers = new Map<string, Promise<string | undefined>>();
  const deleteTimers = new Map<string, unknown>();
  let authFailing = false;
  let tripwire: string | null = null;
  let disposed = false;
  let booting: Promise<void> = Promise.resolve();

  const state = (id: string): ThreadState => {
    let st = states.get(id);
    if (!st) {
      st = { id, again: false, lastUploadAt: null, queued: 0, oldestPendingAt: null, blocked: null, sessionReady: false,
        peers: new Set(), gateScanSeq: 0, lastTurnCompleted: 0, editsDone: new Set() };
      states.set(id, st);
    }
    return st;
  };
  const privacy = async (): Promise<PrivacySettings> => deps.privacy ? await deps.privacy() : readPrivacy(bb.storage.kv);
  const requiresSwitchover = async () => (await deps.settings?.())?.captureRequiresSwitchover ?? true;
  const providerOf = (threadId: string) => {
    let hit = providers.get(threadId);
    if (!hit) {
      hit = (bb.sdk.threads.get({ threadId }) as Promise<Thread>).then(t => t.providerId, () => { providers.delete(threadId); return undefined; });
      providers.set(threadId, hit);
    }
    return hit;
  };
  /** Advance without content (nothing to send), and clear retry state. */
  const settle = (id: string, to: number) => {
    outbox.advance(id, to);
    outbox.clearRetry(id);
  };

  async function readEvents(threadId: string, afterSeq: number, types: readonly EventType[] = READ_TYPES): Promise<CaptureEvent[]> {
    const out: CaptureEvent[] = [];
    for (let after = afterSeq; ;) {
      const page = await bb.sdk.threads.events.list({ threadId, afterSeq: String(after), limit: String(PAGE), order: "asc",
        types: types as [EventType, ...EventType[]] });
      out.push(...page);
      if (page.length < PAGE) return out;
      after = page[page.length - 1].seq;
    }
  }

  // ---------- scheduling ----------

  function schedule(id: string, delay: number): void {
    if (disposed || deleted.has(id)) return;
    const st = state(id);
    const at = clock.now() + Math.max(0, delay);
    if (st.timer !== undefined && st.timerAt! <= at) return;
    if (st.timer !== undefined) clock.clearTimeout(st.timer);
    st.timerAt = at;
    st.timer = clock.setTimeout(() => { st.timer = undefined; void run(id); }, Math.max(0, delay));
  }
  function run(id: string): Promise<void> {
    const st = state(id);
    if (st.running) { st.again = true; return st.running; }
    st.running = limit(() => processThread(st))
      .catch(error => failed(st, error))
      .finally(() => {
        st.running = undefined;
        if (st.again) { st.again = false; schedule(id, 0); }
      });
    return st.running;
  }
  function failed(st: ThreadState, error: unknown): void {
    if (disposed || deleted.has(st.id)) return;
    const kind: RetryError = error instanceof HonchoError ? error.kind : "offline";
    if (kind === "auth") authFailing = true;
    const now = clock.now();
    const retry = outbox.fail(st.id, kind, now);
    if (retry.attempts === 1) deps.activity.record({ kind: "failure", threadId: st.id, summary: `upload failed (${kind}), retrying with backoff`, error: kind });
    bb.log.warn(`honcho capture: ${st.id} failed (${kind}), attempt ${retry.attempts}`);
    // Exponential backoff from the outbox, with jitter so threads don't retry in lockstep.
    schedule(st.id, Math.max(0, retry.nextAt - now) * (0.5 + random() * 0.5));
  }

  // ---------- per-thread pipeline ----------

  /** Returns the switch-over marker (capture covers seq > marker), or undefined while the harness still captures. */
  async function gate(st: ThreadState, thread: Thread): Promise<number | undefined> {
    const known = outbox.switchOver(thread.id);
    if (known !== undefined) return known;
    if (gateAlwaysOpen(thread.providerId) || !(await requiresSwitchover())) {
      // Nothing to hand over, but a thread that predates the plugin must not be captured from seq 0:
      // that would be an implicit backfill, and backfill is opt-in. Its marker is its max seq now.
      let marker = 0;
      if (thread.createdAt < firstStartedAt) {
        const latest = await bb.sdk.threads.events.list({ threadId: thread.id, order: "desc", limit: "1" });
        marker = latest[0]?.seq ?? 0;
      }
      outbox.markSwitchOver(thread.id, marker);
      return outbox.switchOver(thread.id)!;
    }
    const events = await readEvents(thread.id, st.gateScanSeq, GATE_TYPES);
    for (const e of events) {
      const providerThread = providerThreadIdOf(e);
      if (providerThread) outbox.addProviderThread(thread.id, providerThread);
      else if (e.type === "turn/completed") st.lastTurnCompleted = e.seq;
      else if (e.type === "provider.env-resolved") {
        const entries = Array.isArray(data(e).entries) ? data(e).entries as Array<{ name?: unknown }> : [];
        if (entries.some(entry => entry?.name === SWITCHOVER_ENV)) {
          // The prompt that triggered this session build is logged before the
          // build, so the marker sits after the previous session's last turn.
          outbox.markSwitchOver(thread.id, st.lastTurnCompleted);
          deps.activity.record({ kind: "harness", threadId: thread.id, summary: `capture switched over to bb after seq ${st.lastTurnCompleted}` });
          return st.lastTurnCompleted;
        }
      }
      st.gateScanSeq = e.seq;
    }
    st.blocked = NOT_SWITCHED_OVER;
    return undefined;
  }

  /** Forks and side chats start with the source's copied completed turns. bb
   * copies them in one transaction before the fork's own first event, keeping
   * their original createdAt, so they are the prefix older than the fork. */
  async function forkBoundary(thread: Thread): Promise<void> {
    if (thread.originKind !== "fork" || outbox.forkSource(thread.id)) return;
    const events = await readEvents(thread.id, 0, [...READ_TYPES, "turn/started"]);
    if (!events.length) return;
    let boundary = 0;
    for (const e of events) { if (e.createdAt < thread.createdAt) boundary = e.seq; else break; }
    outbox.setForkSource(thread.id, thread.sourceThreadId ?? thread.parentThreadId ?? "", boundary);
  }

  async function transformContext(thread: Thread, accepted: Set<string>, settings: PrivacySettings): Promise<TransformContext> {
    const { config, keys } = await deps.config();
    const patterns = settings.patterns.flatMap(p => { try { return [new RegExp(p)]; } catch { return []; } });
    const parent = thread.parentThreadId ? await providerOf(thread.parentThreadId) : undefined;
    // Peers are resolved before the transform so Memory-page renames apply.
    return {
      userPeer: config.peerName, providerId: await resolvePeer(bb.storage.kv, thread.providerId), acceptedRequestIds: accepted,
      parentProviderId: parent && await resolvePeer(bb.storage.kv, parent),
      originPluginId: thread.originPluginId,
      workflowChild: thread.parentThreadId !== null && thread.originKind !== "fork",
      redaction: { deny: [...keys, ...((await deps.extraDeny?.()) ?? [])], patterns },
    };
  }
  async function transform(events: CaptureEvent[], context: TransformContext): Promise<TransformResult & { providers: string[] }> {
    let result = transformEvents(events, context);
    const used = new Set<string>();
    if (result.unresolvedSenders.length) {
      const senderProviders: Record<string, string> = { ...context.senderProviders };
      for (const sender of new Set(result.unresolvedSenders)) {
        const provider = sender === "parent" ? undefined : await providerOf(sender);
        if (provider) { senderProviders[sender] = await resolvePeer(bb.storage.kv, provider); used.add(provider); }
      }
      // Still-unresolved senders stay withheld; they are never credited to the user.
      result = transformEvents(events, { ...context, senderProviders });
    }
    return { ...result, providers: [...used] };
  }

  async function ensureSession(st: ThreadState, thread: Thread, client: HonchoClient, messages: MessageDraft[], model: string | null, providerIds: string[]): Promise<void> {
    const { config } = await deps.config();
    for (const provider of new Set([thread.providerId, ...providerIds])) await recordProviderSeen(bb.storage.kv, provider, clock.now());
    // Only the user is studied; every ai peer has observe_me off, per session.
    const peers: Record<string, PeerConfig> = {};
    for (const m of messages) if (m.peer_id !== config.peerName) peers[m.peer_id] = { observe_me: false, observe_others: false };
    if (!st.sessionReady) {
      peers[await resolvePeer(bb.storage.kv, thread.providerId)] = { observe_me: false, observe_others: false };
      peers[config.peerName] = { observe_me: true, observe_others: false };
      const env = await facts.env(thread);
      const automationId = messages.map(m => m.content.match(/^\[bb automation due:([^\]]+)\]/)?.[1]).find(Boolean) ?? null;
      const sideChat = thread.originKind === "fork" && thread.originPluginId === "side-chat";
      const metadata = sessionMetadata({
        provider: thread.providerId, model, host: env?.hostId ?? null, environment: env?.id ?? null, project: thread.projectId,
        parentThread: thread.parentThreadId ?? thread.sourceThreadId ?? null,
        origin: sideChat ? "side-chat" : thread.originKind ?? (thread.originPluginId ? `plugin:${thread.originPluginId}` : null),
        ...(sideChat ? { sideChat: true } : {}), automationId,
      });
      await client.getOrCreateSession(thread.id, { metadata, peers, scopes: [await facts.scopeFor(thread)] });
      st.sessionReady = true;
      st.peers = new Set(Object.keys(peers));
      return;
    }
    const added = Object.fromEntries(Object.entries(peers).filter(([peer]) => !st.peers.has(peer)));
    if (Object.keys(added).length) {
      await client.addPeers(thread.id, added);
      for (const peer of Object.keys(added)) st.peers.add(peer);
    }
  }

  /** Messages can't be deleted, so the old branch of an edit is marked instead. */
  async function supersede(threadId: string, from: number, to: number): Promise<void> {
    const client = await deps.client();
    for (const m of await sessionMessages(client, threadId, { bb_thread: threadId, ...seqRange(from, to) })) {
      const seq = Number(m.metadata?.bb_seq);
      if (seq < from || seq > to || m.metadata?.bb_superseded) continue;
      // Honcho replaces metadata on update, so the existing fields are kept.
      await client.updateMessageMetadata(threadId, m.id, { ...m.metadata, bb_superseded: true });
    }
  }

  /** bb's edit_message deletes [cutoffSequence, oldMaxSequence] and appends this
   * event (fields seen in bb's editThreadMessage). Without them, the range is the
   * gap before the event: no capture-relevant event survives inside it. */
  async function editRange(threadId: string, e: CaptureEvent): Promise<[number, number] | null> {
    const meta = (data(e).metadata ?? {}) as Record<string, unknown>;
    let from = Number(meta.cutoffSequence), to = Number(meta.oldMaxSequence);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) {
      const before = await bb.sdk.threads.events.list({ threadId, beforeSeq: String(e.seq), order: "desc", limit: "1",
        types: READ_TYPES as unknown as [EventType, ...EventType[]] });
      from = (before[0]?.seq ?? 0) + 1;
      to = e.seq - 1;
    }
    return from >= 0 && to >= from ? [from, to] : null;
  }

  const lastModel = (events: CaptureEvent[]) => {
    let model: string | null = null;
    for (const e of events) if (e.type === "client/turn/requested") model = (e.data.execution as { model?: string } | undefined)?.model ?? model;
    return model;
  };
  const sendable = (thread: Thread, seq: number, createdAt: number) => outbox.shouldSend(thread.id, seq, { id: thread.projectId, createdAt });

  /** Posts messages; a validation (400/422) rejection splits the batch and retries the
   * halves until the single bad message is found. That message is skipped and recorded
   * in activity (seq and part only, never content). Other errors propagate for backoff.
   * Returns the number of messages skipped. */
  async function post(client: HonchoClient, threadId: string, messages: MessageDraft[]): Promise<number> {
    let skipped = 0;
    const send = async (group: MessageDraft[]): Promise<void> => {
      try { for (const chunk of chunks(group)) await client.createMessages(threadId, chunk); }
      catch (error) {
        if (!(error instanceof HonchoError) || error.kind !== "validation") throw error;
        if (group.length === 1) {
          skipped++;
          deps.activity.record({ kind: "failure", threadId, summary: `skipped message seq ${seqOf(group[0])} part ${partOf(group[0])}: rejected by honcho (validation)`, error: "validation" });
          bb.log.warn(`honcho capture: ${threadId} skipped seq ${seqOf(group[0])} (validation)`);
          return;
        }
        const mid = Math.ceil(group.length / 2);
        await send(group.slice(0, mid));
        await send(group.slice(mid));
      }
    };
    await send(messages);
    authFailing = false;
    return skipped;
  }

  /** Crash recovery: the marker was written but the cursor never moved. Honcho
   * has no idempotency key, so compare by bb_seq/bb_part before resending. */
  async function recover(st: ThreadState, thread: Thread, marker: InFlight, settings: PrivacySettings): Promise<void> {
    const client = await deps.client();
    const existing = await sessionMessages(client, thread.id, { bb_thread: thread.id, ...seqRange(marker.firstSeq, marker.lastSeq) });
    const have = new Set(existing.map(m => `${m.metadata?.bb_seq}:${m.metadata?.bb_part ?? 0}`));
    if (existing.length) st.sessionReady = true;
    // Read past lastSeq too: a prompt's turn/input/accepted can come after the marker.
    const events = await readEvents(thread.id, marker.firstSeq - 1);
    const accepted = new Set(events.flatMap(e => e.type === "turn/input/accepted" ? [e.data.clientRequestId] : []));
    const live = events.filter(e => e.seq <= marker.lastSeq && sendable(thread, e.seq, e.createdAt));
    const result = await transform(live, await transformContext(thread, accepted, settings));
    const missing = result.messages.filter(m => !have.has(`${seqOf(m)}:${partOf(m)}`));
    if (missing.length && !deleted.has(thread.id)) {
      await ensureSession(st, thread, client, missing, lastModel(live), result.providers);
      const skipped = await post(client, thread.id, missing);
      const sent = missing.length - skipped;
      if (sent > 0) st.lastUploadAt = clock.now();
      if (sent > 0) deps.activity.record({ kind: "upload", threadId: thread.id, summary: `resent ${sent} message(s) after an interrupted upload`,
        messages: sent, redactions: result.redactionCount, reasoning: missing.some(m => m.configuration?.reasoning?.enabled === true) });
    }
    outbox.complete(thread.id, marker.lastSeq);
  }

  async function processThread(st: ThreadState): Promise<void> {
    const id = st.id;
    if (disposed || deleted.has(id)) return;
    let thread: Thread;
    try { thread = await bb.sdk.threads.get({ threadId: id }) as Thread; }
    catch (error) { if (isNotFound(error)) return; throw error; }
    if (thread.deletedAt !== null) return;
    st.thread = thread;

    const startSeq = await gate(st, thread);
    if (startSeq === undefined) return;
    const settings = await privacy();
    const deny = await facts.denied(thread, settings);
    if (deny) {
      // Denied threads never upload; what was logged while denied is skipped for good.
      st.blocked = deny; st.queued = 0; st.oldestPendingAt = null;
      const events = await readEvents(id, outbox.cursor(id));
      if (events.length && !outbox.inFlight(id).length) settle(id, events[events.length - 1].seq);
      return;
    }
    st.blocked = null;
    await forkBoundary(thread);
    if (outbox.cursor(id) < captureCursorStart(startSeq) && !outbox.inFlight(id).length) outbox.advance(id, captureCursorStart(startSeq));

    const marker = outbox.inFlight(id)[0];
    if (marker) await recover(st, thread, marker, settings);

    const cursor = outbox.cursor(id);
    const events = await readEvents(id, cursor);
    for (const e of events) { const p = providerThreadIdOf(e); if (p) outbox.addProviderThread(id, p); }

    // Edits: queued seqs in the deleted range are already gone from the log;
    // the ones already sent are marked superseded in Honcho.
    for (const e of events) {
      if (!isEditMessage(e) || st.editsDone.has(e.seq)) continue;
      const range = await editRange(id, e);
      if (range) {
        outbox.supersede(id, range[0], range[1]);
        if (range[0] <= cursor) await supersede(id, range[0], range[1]);
      }
      st.editsDone.add(e.seq);
    }

    const now = clock.now();
    let split = events.findIndex(e => e.createdAt > now - grace);
    if (split < 0) split = events.length;
    const eligible = events.slice(0, split), rest = events.slice(split);
    const accepted = new Set(events.flatMap(e => e.type === "turn/input/accepted" ? [e.data.clientRequestId] : []));
    const rejected = new Set(events.flatMap(e => e.type === "client/turn/rejected" ? [e.data.requestId] : []));
    const createdAt = new Map(events.map(e => [e.seq, e.createdAt]));
    const context = await transformContext(thread, accepted, settings);
    const result = await transform(eligible.filter(e => sendable(thread, e.seq, e.createdAt)), context);

    // A prompt bb hasn't accepted yet holds the cursor just before it.
    const blocking = result.pendingRequests.filter(p => !rejected.has(p.requestId) && (createdAt.get(p.seq) ?? 0) > now - STALE_PENDING_MS);
    const commit = Math.max(cursor, blocking.length ? Math.min(...blocking.map(p => p.seq)) - 1 : eligible.at(-1)?.seq ?? cursor);
    const toSend = result.messages.filter(m => seqOf(m) <= commit);
    const later = [...result.messages.filter(m => seqOf(m) > commit),
      ...transformEvents(rest.filter(e => sendable(thread, e.seq, e.createdAt)), context).messages];
    const oldest = (list: MessageDraft[]) => list.length ? Math.min(...list.map(m => createdAt.get(seqOf(m)) ?? now)) : null;
    st.queued = toSend.length + later.length;
    st.oldestPendingAt = oldest([...toSend, ...later]);
    if (rest.length) schedule(id, rest[0].createdAt + grace - now + 1);
    else if (blocking.length) schedule(id, grace);

    if (toSend.length) await upload(st, thread, toSend, cursor, commit, result, lastModel(eligible));
    else if (commit > cursor || outbox.retry(id)) settle(id, commit);
    st.queued = later.length;
    st.oldestPendingAt = oldest(later);

    if (eligible.some(e => e.type === "turn/completed" && e.seq > startSeq)) await checkTripwire(thread);
  }

  async function upload(st: ThreadState, thread: Thread, messages: MessageDraft[], cursor: number, commit: number,
    result: TransformResult & { providers: string[] }, model: string | null) {
    const client = await deps.client();
    await ensureSession(st, thread, client, messages, model, result.providers);
    const groups = batches(messages);
    let first = cursor + 1;
    for (const [index, group] of groups.entries()) {
      const last = index === groups.length - 1 ? commit : seqOf(group[group.length - 1]);
      // Checked again at send time: a pause set while this batch was built still stops it.
      const ready = group.filter(m => sendable(thread, seqOf(m), Date.parse(m.created_at ?? "") || 0));
      if (disposed || deleted.has(thread.id)) return;
      outbox.begin({ thread: thread.id, firstSeq: Math.min(first, last), lastSeq: last, startedAt: clock.now() });
      const skipped = ready.length ? await post(client, thread.id, ready) : 0;
      outbox.complete(thread.id, last);
      first = last + 1;
      const sent = ready.length - skipped;
      if (sent <= 0) continue;
      st.lastUploadAt = clock.now();
      deps.activity.record({ kind: "upload", threadId: thread.id, summary: `saved ${sent} message(s)`, messages: sent,
        redactions: index === 0 ? result.redactionCount : 0, reasoning: ready.some(m => m.configuration?.reasoning?.enabled === true) });
    }
  }

  // ---------- tripwire ----------

  /** After a captured thread's first turn: did a harness integration also write a session for it? */
  async function checkTripwire(thread: Thread): Promise<void> {
    if (await bb.storage.kv.get(KV.tripwireChecked(thread.id))) return;
    const env = await facts.env(thread);
    const names = new Set<string>();
    for (const providerThreadId of outbox.providerThreads(thread.id)) {
      names.add(sanitizeSessionName(providerThreadId)); // claude-honcho
      if (env?.path) names.add(`${sanitizeSessionName(basename(env.path))}-${sanitizeSessionName(providerThreadId).slice(0, 8)}`); // codex chat-instance
    }
    names.delete(thread.id);
    const client = await deps.client();
    for (const name of names) {
      if (!(await sessionHasMessages(client, name))) continue;
      tripwire = `harness session "${name}" is still capturing thread ${thread.id}`;
      await bb.storage.kv.set(KV.tripwire, tripwire);
      deps.activity.record({ kind: "harness", threadId: thread.id, summary: `tripwire: ${tripwire}`, error: "tripwire" });
      bb.log.warn(`honcho capture: tripwire hit for ${thread.id}`);
      break;
    }
    await bb.storage.kv.set(KV.tripwireChecked(thread.id), true);
  }

  // ---------- deletion ----------

  async function purgeAndDelete(threadId: string, settings: PrivacySettings): Promise<void> {
    const client = await deps.client();
    let purged = 0;
    let capped = false;
    if (settings.purgeConclusionsOnDelete) {
      const own = new Set<string>();
      for (let page = 1; ; page++) {
        const result = await client.listConclusions({ session_id: threadId }, { page, size: 100 });
        for (const c of result.items) own.add(c.id);
        if (result.items.length < 100 || (result.total != null && own.size >= result.total)) break;
      }
      // Derived conclusions carry no session_id and Honcho can't filter by source id, so scan the
      // user's own derived conclusions (observer = observed = peer) in a bounded number of pages,
      // and follow source_ids (transitively) back to this session's conclusions.
      if (own.size) {
        const peer = (await deps.config()).config.peerName;
        const found: Conclusion[] = [];
        for (let page = 1; ; page++) {
          if (page > PURGE_SCAN_PAGES) { capped = true; break; }
          const result = await client.listConclusions({ observer: peer, observed: peer }, { page, size: 100 });
          found.push(...result.items);
          if (result.items.length < 100 || (result.total != null && found.length >= result.total)) break;
        }
        const doomed = new Set<string>();
        for (let grew = true; grew;) {
          grew = false;
          for (const c of found) {
            if (own.has(c.id) || doomed.has(c.id)) continue;
            if ((c.source_ids ?? []).some(x => own.has(x) || doomed.has(x))) { doomed.add(c.id); grew = true; }
          }
        }
        for (const id of doomed) { await client.deleteConclusion(id); purged++; }
        if (capped) bb.log.warn(`honcho capture: purge of ${threadId} scanned only ${PURGE_SCAN_PAGES * 100} conclusions`);
      }
    }
    await client.deleteSession(threadId);
    for (const key of [KV.pendingDelete(threadId), scopeKey(threadId), KV.tripwireChecked(threadId)]) await bb.storage.kv.delete(key);
    deps.activity.record({ kind: "delete", threadId, summary: settings.purgeConclusionsOnDelete
      ? `deleted the honcho session and ${purged} derived conclusion(s)${capped ? ` (scan capped at ${PURGE_SCAN_PAGES * 100} conclusions)` : ""}; the peer card may reflect this thread until it regenerates`
      : "deleted the honcho session" });
  }

  async function onDeleted(threadId: string, attempt = 0): Promise<void> {
    const settings = await privacy();
    deleted.add(threadId);
    const st = states.get(threadId);
    if (st?.timer !== undefined) clock.clearTimeout(st.timer);
    await st?.running?.catch(() => undefined);
    states.delete(threadId);
    if (!settings.deleteOnDelete) {
      if (attempt === 0) deps.activity.record({ kind: "delete", threadId, summary: "thread deleted; honcho session kept (delete-on-delete is off)" });
      return;
    }
    outbox.deleteThread(threadId); // drops queued work and markers
    await bb.storage.kv.set(KV.pendingDelete(threadId), true);
    try { await purgeAndDelete(threadId, settings); }
    catch (error) {
      const kind = error instanceof HonchoError ? error.kind : "offline";
      if (attempt === 0) deps.activity.record({ kind: "failure", threadId, summary: `could not delete the honcho session (${kind}); will retry`, error: kind });
      if (disposed) return;
      const delay = Math.min(300_000, 1_000 * 2 ** Math.min(attempt, 20)) * (0.5 + random() * 0.5);
      deleteTimers.set(threadId, clock.setTimeout(() => { deleteTimers.delete(threadId); void onDeleted(threadId, attempt + 1).catch(() => undefined); }, delay));
    }
  }

  // ---------- startup ----------

  async function boot(): Promise<void> {
    tripwire = (await bb.storage.kv.get<string>(KV.tripwire)) ?? null;
    for (const key of await bb.storage.kv.list(KV.pendingDeletePrefix)) void onDeleted(key.slice(KV.pendingDeletePrefix.length)).catch(() => undefined);
    for (const marker of outbox.inFlight()) schedule(marker.thread, 0);
    // Startup reconcile: catch up on everything missed while the plugin was down.
    for (let offset = 0; !disposed;) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 100, offset });
      for (const t of page) schedule(t.id, 0);
      if (page.length < 100) break;
      offset += page.length;
    }
  }

  return {
    start() {
      const later = (event: { thread: Thread }) => { if (!disposed) schedule(event.thread.id, grace); };
      // experimental_thread.events fires at most once a second per thread; the
      // timer it arms reads once the grace window has passed, not per event.
      for (const name of ["thread.created", "thread.active", "thread.idle", "thread.archived", "experimental_thread.events"] as const) bb.events.on(name, later);
      bb.events.on("thread.deleted", ({ thread }) => disposed ? undefined
        : onDeleted(thread.id).catch(error => bb.log.error(`honcho capture: delete of ${thread.id} failed: ${(error as Error).name}`)));
      booting = boot().catch(error => bb.log.warn(`honcho capture: reconcile failed: ${(error as Error).name}`));
      return () => {
        disposed = true;
        for (const st of states.values()) if (st.timer !== undefined) clock.clearTimeout(st.timer);
        for (const timer of deleteTimers.values()) clock.clearTimeout(timer);
      };
    },

    scopeFor: thread => facts.scopeFor(thread),
    knownScope: threadId => facts.known(threadId),
    isDenied: async thread => (await facts.denied(thread, await privacy())) !== null,

    async threadStatus(threadId): Promise<ThreadMemoryStatus> {
      const st = states.get(threadId);
      const thread = st?.thread ?? await (bb.sdk.threads.get({ threadId }) as Promise<Thread>).catch(() => undefined);
      const scope = (await bb.storage.kv.get<string>(scopeKey(threadId))) ?? null;
      const base = { threadId, lastUploadAt: st?.lastUploadAt ?? null, queued: st?.queued ?? 0, scope };
      if (st?.blocked) return { ...base, state: "not-captured", reason: st.blocked };
      if (outbox.switchOver(threadId) === undefined && thread && !gateAlwaysOpen(thread.providerId) && await requiresSwitchover()) {
        return { ...base, state: "not-captured", reason: NOT_SWITCHED_OVER };
      }
      if (outbox.isPausedNow("thread", threadId) || (thread && outbox.isPausedNow("project", thread.projectId))) return { ...base, state: "paused" };
      if (outbox.retry(threadId)) return { ...base, state: "offline" };
      if ((st?.queued ?? 0) > 0 || outbox.inFlight(threadId).length) return { ...base, state: "saving" };
      return { ...base, state: "idle" };
    },

    async setPaused(target, paused) {
      const now = clock.now();
      // Thread pauses are seq ranges after the newest logged seq; project pauses are createdAt ranges.
      let boundary = now;
      if (target.kind === "thread") {
        const latest = await bb.sdk.threads.events.list({ threadId: target.id, order: "desc", limit: "1" }).catch(() => []);
        boundary = latest[0]?.seq ?? 0;
      }
      outbox.setPaused(target.kind, target.id, paused, boundary, now);
    },

    async pauses() {
      const open = outbox.pauses().filter(r => r.to === null);
      return open.map(r => ({ kind: r.kind, id: r.id, since: r.sinceAt ?? (r.kind === "project" ? r.from : 0) }));
    },

    async health() {
      let queued = 0, oldestPendingAt: number | null = null;
      const older = (at: number | null) => { if (at !== null) oldestPendingAt = Math.min(oldestPendingAt ?? Infinity, at); };
      for (const st of states.values()) { queued += st.queued; older(st.oldestPendingAt); }
      for (const marker of outbox.inFlight()) older(marker.startedAt);
      return { oldestPendingAt, queued, authFailing, tripwire };
    },

    /** Runs scheduled work now, ignoring backoff (the grace window still applies), and waits for it. */
    async flushNow() {
      await booting;
      for (let pass = 0; pass < 5; pass++) {
        const work: Promise<void>[] = [];
        for (const st of states.values()) {
          if (st.timer !== undefined && (pass === 0 || st.timerAt! <= clock.now())) { clock.clearTimeout(st.timer); st.timer = undefined; work.push(run(st.id)); }
          else if (st.running) work.push(st.running);
        }
        if (!work.length) return;
        await Promise.all(work);
      }
    },
  };
}

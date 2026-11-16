// Capture: bb thread event log -> Honcho sessions. See DESIGN.md "Capture" and
// "Privacy and deletion". Nothing here blocks a turn: every bb notification only
// schedules work, and uploads run on timers after the grace window.

import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { PluginThreadEventPayloads } from "@get-bb/plugin-sdk";
import type { CaptureService, HarnessState, PrivacySettings, ThreadMemoryStatus } from "../contract.js";
import { HonchoError, seqRange, type Conclusion, type HonchoClient, type MessageDraft, type PeerConfig } from "../honcho-client.js";
import { sessionMetadata } from "../mapping.js";
import { GATE_VERSION, type InFlight, type RetryError, type SwitchOverMarker } from "../outbox.js";
import { readPrivacy, recordProviderSeen, resolvePeer } from "../rpc-server.js";
import { isEditMessage, providerThreadIdOf, transformEvents, type CaptureEvent, type TransformContext, type TransformResult } from "../transform.js";
import { sessionNewestMessageAt, sessionMessages, systemClock, type CaptureBb, type CaptureDeps } from "./ports.js";
import { captureCursorStart, gateAlwaysOpen } from "./switchover.js";
export { gateAlwaysOpen } from "./switchover.js";
import { FactsUnavailable, scopeKey, threadFacts, type ThreadRef } from "./scope.js";
import { FORK_SCAN_TYPES, forkBoundarySeq } from "./fork.js";

type Thread = PluginThreadEventPayloads["thread.created"]["thread"];
type EventType = CaptureEvent["type"];

/** Only the types capture looks at; bb never returns deltas, usage or diffs here. */
const READ_TYPES = ["client/turn/requested", "turn/input/accepted", "client/turn/rejected", "item/completed", "turn/completed",
  "system/operation", "thread/identity", "provider.env-resolved"] as const satisfies readonly EventType[];
/** What the gate needs to tell a session build from a steer: see gate(). */
const GATE_TYPES = ["client/turn/requested", "client/thread/start", "thread/identity", "turn/input/accepted", "provider.env-resolved",
  "turn/completed"] as const satisfies readonly EventType[];
const PAGE = 100; // bb rejects thread event pages above 100
const BATCH = 100;
/** Purge-on-delete scans at most this many pages of 100 derived conclusions: Honcho can't filter by source id. */
const PURGE_SCAN_PAGES = 50;
/** A prompt that never got turn/input/accepted stops holding the cursor back after this. */
const STALE_PENDING_MS = 10 * 60_000;
/** A thread's upload lease outlives any one POST (the client times out at 8 s) and is
 * renewed before each, so a live uploader never loses it; a crashed one's expires. */
export const LEASE_TTL_MS = 60_000;
/** How soon a thread whose lease another generation holds is tried again. */
const LEASE_RETRY_MS = 5_000;
/** threads.list accepts at most this many threadIds per call. */
const THREAD_IDS_PER_LIST = 200;
export const SWITCHOVER_ENV = "BB_HONCHO";
export const NOT_SWITCHED_OVER = "the old harness honcho plugin still saves this chat until its session restarts: send a message after a hand over (Memory → connection) or start a new chat";
/** A thread no gate scan has looked at yet (new, or the plugin just started). */
export const GATE_PENDING = "checking whether this chat has switched over";
export const PROBATION = "checking the old honcho plugin is quiet";
const harnessSeen = (at: number) => `the old honcho plugin wrote at ${new Date(at).toISOString()} after the session rebuilt; capture waits for the next rebuild`;
/** The thread a tripwire message names (see checkTripwire). */
const tripwireThread = (message: string | null) => message?.match(/capturing thread (\S+)$/)?.[1];
const HANDOVER_TTL_MS = 3 * 60_000;
/** The harness a thread's provider uses, for hand-over state. */
const harnessOf = (providerId: string): "claude" | "codex" | undefined => providerId === "claude-code" ? "claude" : providerId === "codex" ? "codex" : undefined;
/** When a backup set's name says it was made: "000001-2026-11-15T10-00-00-000Z-handover". */
const backupTime = (name: string): number => {
  const m = name.match(/^\d+-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-(.+)$/);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`) : NaN;
};

const KV = {
  tripwireChecked: (t: string) => `capture:tripwire-checked:${t}`,
  tripwire: "capture:tripwire",
  /** Which thread the tripwire names and when the harness wrote: {thread, at}. */
  tripwireMeta: "capture:tripwire-meta",
  /** Only a session build after this time (a hand over) may switch the thread over. */
  regate: (t: string) => `capture:regate:${t}`,
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
  /** A gate scan has run for this thread since the plugin started. */
  gateScanned?: boolean;
  /** Builds at or before this (a hand over, after a cleared harness write) don't switch the thread over; undefined = not loaded. */
  regateAt?: number | null;
  lastTurnCompleted: number;
  /** The gate scan's current span: since the newest client/turn/requested, was a session built
   * (client/thread/start, thread/identity) and was the input accepted into a running turn? */
  span: { requested: boolean; built: boolean; accepted: boolean };
  editsDone: Set<number>;
  /** Newest seq bb reported for the thread (experimental_thread.events), or read from its log. */
  seenSeq: number;
}

const data = (e: CaptureEvent) => e.data as unknown as Record<string, unknown>;
const seqOf = (m: MessageDraft) => Number(m.metadata?.bb_seq);
const partOf = (m: MessageDraft) => Number(m.metadata?.bb_part ?? 0);
const isNotFound = (e: unknown) => (e as { status?: number } | null)?.status === 404 || (e as { code?: string } | null)?.code === "thread_not_found";
const honchoNotFound = (e: unknown) => e instanceof HonchoError && e.status === 404;
/** claude-honcho's sanitizeForSessionName / getSessionName. */
export const sanitizeSessionName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");

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
/** Another plugin generation holds this thread's upload lease (a reload overlap). */
class LeaseBusy extends Error { constructor() { super("lease held by another generation"); this.name = "LeaseBusy"; } }
/** This generation was disposed mid-thread; the in-flight marker lets the next one recover. */
class Stopped extends Error { constructor() { super("capture stopped"); this.name = "Stopped"; } }

const chunks = <T>(items: T[]) => Array.from({ length: Math.ceil(items.length / BATCH) }, (_, i) => items.slice(i * BATCH, (i + 1) * BATCH));

export type CaptureHandle = CaptureService & {
  /** Registers the bb event listeners. Call it inside the plugin factory, as bb requires. */
  listen(): void;
  /** Startup catch-up (pending deletes, interrupted uploads, every thread's cursor). Run it from a
   * background service, which starts only once the factory completed and is aborted on dispose. */
  reconcile(signal?: AbortSignal): Promise<void>;
  /** Stops scheduling and further POSTs; idempotent. */
  stop(): void;
  /** listen() plus reconcile(), returning stop: for tests and callers without a service. */
  start(): () => void;
  /** The plugin's one scope resolver and cache; backfill and recall use it too. */
  scopeFor(thread: ThreadRef): Promise<string>;
  /** The scope already resolved for a thread in this load, synchronously (recall's configure reads it). */
  knownScope(threadId: string): string | null;
  /** True when the privacy deny list covers the thread. */
  isDenied(thread: ThreadRef): Promise<boolean>;
  /** Privacy settings changed: forget cached deny decisions and re-evaluate held threads now. */
  privacyChanged(): void;
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
  const deleting = new Set<string>();
  const providers = new Map<string, Promise<string | undefined>>();
  const deleteTimers = new Map<string, unknown>();
  let authFailing = false;
  let tripwire: string | null = null;
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  let booting: Promise<void> = Promise.resolve();
  let listening = false;
  /** This generation's lease owner id. A reload's new generation gets a new one. */
  const owner = deps.leaseOwner ?? randomUUID();
  const leaseTtl = deps.leaseTtlMs ?? LEASE_TTL_MS;
  /** Renewed before every POST: a lease that lapsed and was taken over stops this uploader. */
  const holdLease = (id: string) => {
    if (disposed) throw new Stopped();
    if (!outbox.acquireLease(id, owner, clock.now(), leaseTtl)) throw new LeaseBusy();
  };

  const state = (id: string): ThreadState => {
    let st = states.get(id);
    if (!st) {
      st = { id, again: false, lastUploadAt: null, queued: 0, oldestPendingAt: null, blocked: null, sessionReady: false,
        peers: new Set(), gateScanSeq: 0, lastTurnCompleted: 0, span: { requested: false, built: false, accepted: false }, editsDone: new Set(), seenSeq: 0 };
      states.set(id, st);
    }
    return st;
  };
  const privacy = async (): Promise<PrivacySettings> => deps.privacy ? await deps.privacy() : readPrivacy(bb.storage.kv);
  const requiresSwitchover = async () => (await deps.settings?.())?.captureRequiresSwitchover ?? true;
  /** A thread's provider. A thread bb doesn't have resolves to undefined (a truly unknown sender);
   * any other failure rejects, so the caller holds its cursor and retries instead of skipping. */
  const providerOf = (threadId: string) => {
    let hit = providers.get(threadId);
    if (!hit) {
      hit = (bb.sdk.threads.get({ threadId }) as Promise<Thread>).then(t => t.providerId, error => {
        if (isNotFound(error)) return undefined;
        providers.delete(threadId);
        throw error;
      });
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
      const last = page.at(-1)?.seq;
      if (last !== undefined) { const st = states.get(threadId); if (st) st.seenSeq = Math.max(st.seenSeq, last); }
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
    st.running = limit(() => leased(st))
      .catch(error => failed(st, error))
      .finally(() => {
        st.running = undefined;
        if (st.again) { st.again = false; schedule(id, 0); }
      });
    return st.running;
  }
  /** One generation at a time per thread: the lease is taken before anything is posted or
   * recovered, and released after. Another generation's live lease means try again soon. */
  async function leased(st: ThreadState): Promise<void> {
    if (disposed || deleted.has(st.id)) return;
    if (!outbox.acquireLease(st.id, owner, clock.now(), leaseTtl)) throw new LeaseBusy();
    try { await processThread(st); }
    finally { try { outbox.releaseLease(st.id, owner); } catch { /* database closed on dispose: the lease expires */ } }
  }
  function failed(st: ThreadState, error: unknown): void {
    if (disposed || deleted.has(st.id) || error instanceof Stopped) return;
    if (error instanceof LeaseBusy) { schedule(st.id, LEASE_RETRY_MS); return; }
    const kind: RetryError = error instanceof HonchoError ? (error.kind === "timeout" ? "offline" : error.kind) : "offline";
    if (kind === "auth") authFailing = true;
    const now = clock.now();
    const retry = outbox.fail(st.id, kind, now);
    if (retry.attempts === 1) deps.activity.record({ kind: "failure", threadId: st.id, summary: `upload failed (${kind}), retrying with backoff`, error: kind });
    // Non-honcho errors (bb sdk, facts lookups) say why, so a stuck thread is diagnosable; the
    // message is cut short and carries no request bodies.
    const why = error instanceof HonchoError ? "" : `: ${error instanceof Error ? `${error.name} ${error.message}` : String(error)}`.slice(0, 200);
    bb.log.warn(`honcho capture: ${st.id} failed (${kind}), attempt ${retry.attempts}${why}`);
    // Exponential backoff from the outbox, with jitter so threads don't retry in lockstep.
    schedule(st.id, Math.max(0, retry.nextAt - now) * (0.5 + random() * 0.5));
  }

  // ---------- per-thread pipeline ----------

  /** Returns the switch-over marker (capture covers seq > marker), or undefined while the harness still captures. */
  async function gate(st: ThreadState, thread: Thread): Promise<number | undefined> {
    st.gateScanned = true;
    const known = outbox.switchOverMarker(thread.id);
    if (known && known.gateVersion >= GATE_VERSION) return known.startSeq;
    const open = gateAlwaysOpen(thread.providerId) || !(await requiresSwitchover());
    if (known) return reevaluate(st, thread, known, open);
    if (open) {
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
    const build = await findBuild(st, thread.id);
    if (!build) { st.blocked = blockedReason(thread.id); return undefined; }
    outbox.markSwitchOver(thread.id, build.marker, { builtSeq: build.seq, builtAt: build.at, probation: true });
    deps.activity.record({ kind: "harness", threadId: thread.id,
      summary: `session rebuilt with the harness capture off at seq ${build.seq}; capture will cover seq ${build.marker + 1} on, once the old honcho plugin is seen quiet` });
    return build.marker;
  }
  const blockedReason = (threadId: string) => { const at = outbox.harnessSeenAt(threadId); return at === undefined ? NOT_SWITCHED_OVER : harnessSeen(at); };

  /** Scans the gate events from where the last scan stopped for the first BB_HONCHO env event that
   * belongs to a real session build: bb logs provider.env-resolved both when it builds a provider
   * session and when a message steers into a running turn (no new process, so the harness keeps
   * its old env). It is a build when, since the newest client/turn/requested, bb logged
   * client/thread/start or thread/identity and no turn/input/accepted came first. A build at or
   * before a time the harness was seen writing after an earlier build doesn't count. */
  async function findBuild(st: ThreadState, threadId: string): Promise<{ marker: number; seq: number; at: number } | undefined> {
    if (st.regateAt === undefined) st.regateAt = (await bb.storage.kv.get<number>(KV.regate(threadId))) ?? null;
    const seenAt = Math.max(outbox.harnessSeenAt(threadId) ?? -Infinity, st.regateAt ?? -Infinity);
    const events = await readEvents(threadId, st.gateScanSeq, GATE_TYPES);
    for (const e of events) {
      st.gateScanSeq = e.seq;
      // provider.env-resolved carries a providerThreadId too, so this can't be an else-if chain.
      const providerThread = providerThreadIdOf(e);
      if (providerThread) outbox.addProviderThread(threadId, providerThread);
      const span = st.span;
      switch (e.type) {
        case "turn/completed": st.lastTurnCompleted = e.seq; break;
        case "client/turn/requested": st.span = { requested: true, built: false, accepted: false }; break;
        case "client/thread/start": case "thread/identity": if (span.requested) span.built = true; break;
        case "turn/input/accepted": if (span.requested) span.accepted = true; break;
        case "provider.env-resolved": {
          const entries = Array.isArray(data(e).entries) ? data(e).entries as Array<{ name?: unknown }> : [];
          if (!entries.some(entry => entry?.name === SWITCHOVER_ENV)) break;
          if (!span.requested || !span.built || span.accepted || e.createdAt <= seenAt) break;
          // The prompt that triggered this session build is logged before the
          // build, so the marker sits after the previous session's last turn.
          return { marker: st.lastTurnCompleted, seq: e.seq, at: e.createdAt };
        }
      }
    }
    return undefined;
  }

  /** A marker an older gate rule made (gate_version 1 trusted steers too): rescan the thread with
   * the current rule, moving the marker forward or dropping it. Cursors stay: what was uploaded
   * can't be taken back. A tripwire hit for the thread that the new marker explains is cleared. */
  async function reevaluate(st: ThreadState, thread: Thread, old: SwitchOverMarker, open: boolean): Promise<number | undefined> {
    const id = thread.id;
    if (open) { outbox.replaceSwitchOver(id, old.startSeq); return old.startSeq; }
    Object.assign(st, { gateScanSeq: 0, lastTurnCompleted: 0, span: { requested: false, built: false, accepted: false } });
    const build = await findBuild(st, id);
    if (build) {
      outbox.replaceSwitchOver(id, build.marker, { builtSeq: build.seq, builtAt: build.at, probation: true });
      deps.activity.record({ kind: "harness", threadId: id, summary: build.marker === old.startSeq
        ? `re-checked the switch-over with the stricter gate: still after seq ${old.startSeq}; checking the old honcho plugin is quiet`
        : `re-checked the switch-over with the stricter gate: moved from after seq ${old.startSeq} to after seq ${build.marker} (session rebuilt at seq ${build.seq}); checking the old honcho plugin is quiet` });
      if (build.marker !== old.startSeq) await clearTripwireFor(id);
      return build.marker;
    }
    outbox.dropSwitchOver(id);
    deps.activity.record({ kind: "harness", threadId: id,
      summary: `re-checked the switch-over with the stricter gate: no session rebuild since seq ${old.startSeq} turned the harness capture off; capture waits for one` });
    await clearTripwireFor(id);
    st.blocked = blockedReason(id);
    return undefined;
  }

  /** Probation: a switched-over thread's uploads wait until the first turn after the session build
   * completed, the grace window passed, and no harness-named session got a message after the build.
   * Returns true once passed. A hit drops the marker and records when the harness wrote. */
  async function probation(st: ThreadState, thread: Thread, marker: SwitchOverMarker): Promise<boolean> {
    const id = thread.id;
    st.blocked = PROBATION;
    const builtSeq = marker.builtSeq ?? marker.startSeq;
    const done = (await bb.sdk.threads.events.list({ threadId: id, afterSeq: String(builtSeq), order: "asc", limit: "1", types: ["turn/completed"] }))[0];
    if (!done) return false; // the turn's own events reschedule the thread
    const due = done.createdAt + grace;
    if (clock.now() < due) { schedule(id, due - clock.now() + 1); return false; }
    const since = marker.builtAt ?? await switchedAt(id, marker.startSeq);
    const hit = await harnessWrite(thread, since);
    if (hit) {
      outbox.dropSwitchOver(id, hit.at);
      await bb.storage.kv.delete(KV.tripwireChecked(id));
      await raiseTripwire(thread, hit.name, `probation failed: harness session "${hit.name}" wrote at ${new Date(hit.at).toISOString()}, after the session rebuilt at seq ${builtSeq}; nothing was uploaded, and capture waits for a newer rebuild`, hit.at);
      st.blocked = harnessSeen(hit.at);
      return false;
    }
    outbox.passProbation(id);
    await bb.storage.kv.set(KV.tripwireChecked(id), true);
    deps.activity.record({ kind: "harness", threadId: id, summary: `the old honcho plugin stayed quiet through the first turn after the session rebuilt; capture starts after seq ${marker.startSeq}` });
    await clearTripwireFor(id);
    st.blocked = null;
    return true;
  }

  /** Forks and side chats start with the source's copied completed turns. bb
   * copies them in one transaction before the fork's own first event, keeping
   * their original createdAt, so they are the prefix older than the fork. */
  async function forkBoundary(thread: Thread): Promise<void> {
    if (thread.originKind !== "fork" || outbox.forkSource(thread.id)) return;
    const boundary = await forkBoundarySeq(thread, () => readEvents(thread.id, 0, FORK_SCAN_TYPES));
    if (boundary === undefined) return;
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
  /** Send-time gate. A project pause stops anything it overlapped between the event's creation and now. */
  const sendable = (thread: Thread, seq: number, createdAt: number) => outbox.shouldSend(thread.id, seq, { id: thread.projectId, createdAt, sendAt: clock.now() });

  /** Posts messages in POSTs of at most 100. A validation (400/422) rejection splits only
   * the rejected POST and retries its halves until the single bad message is found; POSTs
   * already accepted are never sent again. The bad message is skipped and recorded in
   * activity (seq and part only, never content). Other errors propagate for backoff.
   * Returns the number of messages skipped. */
  async function post(client: HonchoClient, threadId: string, messages: MessageDraft[]): Promise<number> {
    let skipped = 0;
    const send = async (chunk: MessageDraft[]): Promise<void> => {
      try { holdLease(threadId); await client.createMessages(threadId, chunk); }
      catch (error) {
        if (!(error instanceof HonchoError) || error.kind !== "validation") throw error;
        if (chunk.length === 1) {
          skipped++;
          deps.activity.record({ kind: "failure", threadId, summary: `skipped message seq ${seqOf(chunk[0])} part ${partOf(chunk[0])}: rejected by honcho (validation)`, error: "validation" });
          bb.log.warn(`honcho capture: ${threadId} skipped seq ${seqOf(chunk[0])} (validation)`);
          return;
        }
        const mid = Math.ceil(chunk.length / 2);
        await send(chunk.slice(0, mid));
        await send(chunk.slice(mid));
      }
    };
    for (const chunk of chunks(messages)) await send(chunk);
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
    catch (error) { if (isNotFound(error)) { goneWhileDown(id); return; } throw error; }
    if (thread.deletedAt !== null) { goneWhileDown(id); return; }
    st.thread = thread;

    await applyHandover(st, thread);
    const startSeq = await gate(st, thread);
    if (startSeq === undefined) return;
    const settings = await privacy();
    let deny: string | null;
    try { deny = await facts.denied(thread, settings); }
    catch (error) {
      // Fail closed: without the environment or git facts the deny list can't be checked, so
      // nothing is uploaded and the cursor stays put; the backoff retries.
      if (error instanceof FactsUnavailable) st.blocked = error.message;
      throw error;
    }
    if (deny) {
      // Denied threads never upload; what was logged while denied is skipped for good.
      st.blocked = deny; st.queued = 0; st.oldestPendingAt = null;
      const events = await readEvents(id, outbox.cursor(id));
      if (events.length && !outbox.inFlight(id).length) settle(id, events[events.length - 1].seq);
      return;
    }
    const switched = outbox.switchOverMarker(id);
    if (switched?.probation && !(await probation(st, thread, switched))) return;
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

    if (eligible.some(e => e.type === "turn/completed" && e.seq > startSeq)) await checkTripwire(thread, startSeq);
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

  /** The createdAt of the first event after the marker: when the thread switched over, for markers
   * that don't record their session build. */
  async function switchedAt(threadId: string, marker: number): Promise<number> {
    const first = await bb.sdk.threads.events.list({ threadId, afterSeq: String(marker), order: "asc", limit: "1" });
    return first[0]?.createdAt ?? clock.now();
  }

  /** Did a harness integration write a session for this thread at or after `since`? Returns the
   * first harness session found and when its newest message was created. */
  async function harnessWrite(thread: Thread, since: number): Promise<{ name: string; at: number } | null> {
    // Writes before the hand over were explained by it: the old plugin was still installed then.
    since = Math.max(since, (await handedOverAt(thread)) ?? -Infinity);
    const env = await facts.env(thread);
    const names = new Set<string>();
    for (const providerThreadId of outbox.providerThreads(thread.id)) {
      names.add(sanitizeSessionName(providerThreadId)); // claude-honcho
      if (env?.path) names.add(`${sanitizeSessionName(basename(env.path))}-${sanitizeSessionName(providerThreadId).slice(0, 8)}`); // codex chat-instance
    }
    names.delete(thread.id);
    const client = await deps.client();
    for (const name of names) {
      const at = await sessionNewestMessageAt(client, name);
      if (at !== null && at >= since) return { name, at };
    }
    return null;
  }

  // ---------- hand over ----------

  const handovers = new Map<string, { at: number; state: Promise<HarnessState | null> }>();
  const handoverTtl = deps.handoverTtlMs ?? HANDOVER_TTL_MS;
  /** The machine's harness state, cached for a few minutes; null when it can't be read. */
  function machineState(hostId: string): Promise<HarnessState | null> {
    const hit = handovers.get(hostId);
    if (hit && clock.now() - hit.at < handoverTtl) return hit.state;
    const state = deps.harnessState
      ? deps.harnessState(hostId).then(s => s, () => { handovers.delete(hostId); return null; })
      : Promise.resolve(null);
    handovers.set(hostId, { at: clock.now(), state });
    return state;
  }
  /** When the thread's harness was handed over on its machine (epoch ms); null when it isn't
   * (or the state is unknown). Taken from the newest hand-over backup set's name. */
  async function handedOverAt(thread: Thread): Promise<number | null> {
    const harness = harnessOf(thread.providerId);
    if (!harness || !deps.harnessState) return null;
    let hostId: string | undefined;
    try { hostId = (await facts.env(thread))?.hostId; } catch { return null; }
    if (!hostId) return null;
    const state = await machineState(hostId);
    if (!state?.[harness].handedOver) return null;
    const times = state.backups.filter(n => /-handover$/i.test(n)).map(backupTime).filter(Number.isFinite);
    return times.length ? Math.max(...times) : (handovers.get(hostId)?.at ?? clock.now());
  }
  /** A handed-over harness can't be the writer any more: harness writes and a tripwire recorded
   * before the hand over are cleared, and only a session build after it switches the thread over.
   * Writes after it stay. */
  async function applyHandover(st: ThreadState, thread: Thread): Promise<void> {
    const at = await handedOverAt(thread);
    if (at === null) return;
    const id = thread.id;
    const seen = outbox.harnessSeenAt(id);
    // A tripwire raised before tripwire-meta existed has no meta: its text names the thread, and
    // the recorded harness write (if any) says when the old plugin wrote.
    const blame = await blamedThread();
    const tripped = blame?.thread === id && (blame.at ?? seen ?? -Infinity) < at;
    if (!(seen !== undefined && seen < at) && !tripped) return;
    if (seen !== undefined && seen < at) outbox.clearHarnessSeen(id);
    st.regateAt = Math.max(st.regateAt ?? -Infinity, at);
    await bb.storage.kv.set(KV.regate(id), st.regateAt);
    Object.assign(st, { gateScanSeq: 0, lastTurnCompleted: 0, span: { requested: false, built: false, accepted: false }, blocked: null });
    deps.activity.record({ kind: "harness", threadId: id, summary: `the old ${harnessOf(thread.providerId)} honcho plugin was handed over at ${new Date(at).toISOString()}; its earlier writes no longer block this chat, and the next session build switches it over` });
    if (tripped) await clearTripwireFor(id);
    await bb.storage.kv.delete(KV.tripwireChecked(id));
  }
  /** The thread the stored tripwire blames, and when its harness write was (when recorded). */
  async function blamedThread(): Promise<{ thread: string; at?: number } | undefined> {
    const meta = await bb.storage.kv.get<{ thread: string; at: number }>(KV.tripwireMeta);
    if (meta) return meta;
    const thread = tripwireThread((await bb.storage.kv.get<string>(KV.tripwire)) ?? tripwire);
    return thread ? { thread } : undefined;
  }
  /** Re-checks every thread a harness write or the tripwire blames against the harness state. */
  function recheckBlamed(): void {
    for (const id of outbox.knownThreads()) if (outbox.harnessSeenAt(id) !== undefined) schedule(id, 0);
    void blamedThread().then(blame => { if (blame) schedule(blame.thread, 0); }, () => undefined);
  }
  /** Harness activity (a connect, hand over or undo) makes the cached state stale; threads that
   * were blamed re-check. */
  function handoverChanged(): void {
    handovers.clear();
    recheckBlamed();
  }
  /** The blame is also re-checked at startup and every cache lifetime, so a hand over this plugin
   * never heard about (another generation, the CLI, a restart) still clears it. */
  let recheckTimer: unknown;
  function armRecheck(): void {
    if (disposed) return;
    recheckTimer = clock.setTimeout(() => { recheckBlamed(); armRecheck(); }, handoverTtl);
  }

  async function raiseTripwire(thread: Thread, name: string, summary: string, at: number): Promise<void> {
    const harness = harnessOf(thread.providerId) ?? thread.providerId;
    const chat = (thread as { title?: string | null }).title || thread.id;
    const handed = typeof await handedOverAt(thread) === "number";
    tripwire = handed
      ? `the old ${harness} honcho plugin still saves chat ${chat} even after hand over on this machine; restart that chat or look for another honcho install (harness session "${name}")`
      : `the old ${harness} honcho plugin is still saving chat ${chat}. hand over on this machine (Memory → connection) or restart that chat (harness session "${name}")`;
    await bb.storage.kv.set(KV.tripwire, tripwire);
    await bb.storage.kv.set(KV.tripwireMeta, { thread: thread.id, at });
    deps.activity.record({ kind: "harness", threadId: thread.id, summary: `tripwire: ${summary}`, error: "tripwire" });
    bb.log.warn(`honcho capture: tripwire hit for ${thread.id}`);
  }

  /** Clears the tripwire badge when it names this thread: a re-evaluation explained it, or the
   * thread has since passed its probation. */
  async function clearTripwireFor(threadId: string): Promise<void> {
    const stored = (await bb.storage.kv.get<string>(KV.tripwire)) ?? tripwire;
    const meta = await bb.storage.kv.get<{ thread: string }>(KV.tripwireMeta);
    if ((meta?.thread ?? tripwireThread(stored)) !== threadId) return;
    tripwire = null;
    await bb.storage.kv.delete(KV.tripwire);
    await bb.storage.kv.delete(KV.tripwireMeta);
    await bb.storage.kv.delete(KV.tripwireChecked(threadId));
    deps.activity.record({ kind: "harness", threadId, summary: "cleared the tripwire for this thread: it predates the stricter switch-over check, or the old honcho plugin has since been seen quiet" });
  }

  /** After a captured thread's first turn: did a harness integration also write a session for it?
   * Only harness messages written after this thread's switch-over count: a session the harness
   * filled before bb took over is expected, not a double capture. Threads on probation are checked
   * there instead; this covers markers without one (capture not requiring the switch-over). */
  async function checkTripwire(thread: Thread, marker: number): Promise<void> {
    if (await bb.storage.kv.get(KV.tripwireChecked(thread.id))) return;
    const hit = await harnessWrite(thread, await switchedAt(thread.id, marker));
    if (hit) await raiseTripwire(thread, hit.name, `harness session "${hit.name}" is still capturing thread ${thread.id}`, hit.at);
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
        // A session that never reached Honcho has no conclusions.
        const result = await client.listConclusions({ session_id: threadId }, { page, size: 100 })
          .catch(error => { if (honchoNotFound(error)) return { items: [] as Conclusion[], total: 0 }; throw error; });
        for (const c of result.items) own.add(c.id);
        if (result.items.length < 100 || (result.total != null && own.size >= result.total)) break;
      }
      // Unattached conclusions from honcho_conclude: no session_id, so neither the list above nor the
      // session cascade reaches them. Delete them by id, and chase what was derived from them.
      const loose = deps.unattachedConclusions?.(threadId) ?? [];
      for (const id of loose) {
        try { await client.deleteConclusion(id); purged++; }
        catch (error) { if (!honchoNotFound(error)) throw error; }
        own.add(id);
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
    // 404: the session never reached Honcho (deleted inside the grace window) or is already gone.
    try { await client.deleteSession(threadId); }
    catch (error) { if (!honchoNotFound(error)) throw error; }
    for (const key of [KV.pendingDelete(threadId), scopeKey(threadId), KV.tripwireChecked(threadId), KV.regate(threadId)]) await bb.storage.kv.delete(key);
    deps.activity.record({ kind: "delete", threadId, summary: settings.purgeConclusionsOnDelete
      ? `deleted the honcho session and ${purged} derived conclusion(s)${capped ? ` (scan capped at ${PURGE_SCAN_PAGES * 100} conclusions)` : ""}; the peer card may reflect this thread until it regenerates`
      : "deleted the honcho session" });
  }

  async function onDeleted(threadId: string, attempt = 0): Promise<void> {
    // One deletion per thread: the bb event, startup catch-up and a run that found the thread gone can race.
    if (attempt === 0) { if (deleting.has(threadId)) return; deleting.add(threadId); }
    deleted.add(threadId);
    const settings = await privacy();
    const st = states.get(threadId);
    if (st?.timer !== undefined) clock.clearTimeout(st.timer);
    await st?.running?.catch(() => undefined);
    states.delete(threadId);
    if (!settings.deleteOnDelete) {
      // The thread is gone, so there is nothing left to upload: drop its local state either way.
      outbox.deleteThread(threadId);
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

  /** A thread bb no longer has (deleted, possibly while the plugin was down): handle it as a
   * deletion. Not awaited: onDeleted waits for the thread's running work, which may be the caller. */
  function goneWhileDown(threadId: string): void {
    if (disposed || deleted.has(threadId)) return;
    void onDeleted(threadId).catch(error => bb.log.error(`honcho capture: delete of ${threadId} failed: ${(error as Error).name}`));
  }

  /** bb deleted, while nobody listened, threads the outbox still has state for: threads.list
   * leaves deleted ids out. Each missing one is confirmed with threads.get before it is deleted,
   * so a list that ignored the filter can't delete a live thread's session. */
  async function reconcileDeleted(signal?: AbortSignal): Promise<void> {
    const known = outbox.knownThreads();
    for (let i = 0; i < known.length && !disposed && !signal?.aborted; i += THREAD_IDS_PER_LIST) {
      const ids = known.slice(i, i + THREAD_IDS_PER_LIST);
      const rows = await bb.sdk.threads.list({ threadIds: ids, includeHidden: true, limit: ids.length });
      const live = new Set(rows.filter(r => !r.deletedAt).map(r => r.id));
      for (const id of ids) {
        if (live.has(id)) continue;
        const gone = await (bb.sdk.threads.get({ threadId: id }) as Promise<Thread>).then(t => t.deletedAt !== null, error => isNotFound(error) ? true : undefined);
        if (gone) goneWhileDown(id);
      }
    }
  }

  // ---------- startup ----------

  async function boot(signal?: AbortSignal): Promise<void> {
    tripwire = (await bb.storage.kv.get<string>(KV.tripwire)) ?? null;
    recheckBlamed();
    for (const key of await bb.storage.kv.list(KV.pendingDeletePrefix)) void onDeleted(key.slice(KV.pendingDeletePrefix.length)).catch(() => undefined);
    await reconcileDeleted(signal).catch(error => bb.log.warn(`honcho capture: deletion check failed: ${(error as Error).name}`));
    for (const marker of outbox.inFlight()) schedule(marker.thread, 0);
    // Markers an older gate rule made are re-evaluated first thing (archived threads too).
    for (const id of outbox.staleSwitchOvers()) schedule(id, 0);
    // Startup reconcile: catch up on everything missed while the plugin was down.
    for (let offset = 0; !disposed && !signal?.aborted;) {
      const page = await bb.sdk.threads.list({ archived: false, includeHidden: true, limit: 100, offset });
      for (const t of page) schedule(t.id, 0);
      if (page.length < 100) break;
      offset += page.length;
    }
  }

  function stop(): void {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    if (recheckTimer !== undefined) clock.clearTimeout(recheckTimer);
    for (const st of states.values()) if (st.timer !== undefined) clock.clearTimeout(st.timer);
    for (const timer of deleteTimers.values()) clock.clearTimeout(timer);
    // Leases of threads mid-upload are released when that upload stops (it checks before each POST).
    for (const st of states.values()) if (!st.running) { try { outbox.releaseLease(st.id, owner); } catch { /* closed */ } }
  }
  function listen(): void {
    if (listening) return;
    listening = true;
    armRecheck();
    unsubscribe = deps.activity.subscribe?.(e => { if (e.kind === "harness" && e.threadId === undefined) handoverChanged(); });
    const later = (event: { thread: Thread; sequence?: number }) => {
      if (disposed) return;
      if (typeof event.sequence === "number") { const st = state(event.thread.id); st.seenSeq = Math.max(st.seenSeq, event.sequence); }
      schedule(event.thread.id, grace);
    };
    // experimental_thread.events fires at most once a second per thread; the
    // timer it arms reads once the grace window has passed, not per event.
    for (const name of ["thread.created", "thread.active", "thread.idle", "thread.archived", "experimental_thread.events"] as const) bb.events.on(name, later);
    bb.events.on("thread.deleted", ({ thread }) => disposed ? undefined
      : onDeleted(thread.id).catch(error => bb.log.error(`honcho capture: delete of ${thread.id} failed: ${(error as Error).name}`)));
  }
  function reconcile(signal?: AbortSignal): Promise<void> {
    if (disposed) return Promise.resolve();
    booting = boot(signal).catch(error => bb.log.warn(`honcho capture: reconcile failed: ${(error as Error).name}`));
    return booting;
  }

  return {
    listen, reconcile, stop,
    start() {
      listen();
      void reconcile();
      return stop;
    },

    scopeFor: thread => facts.scopeFor(thread),
    knownScope: threadId => facts.known(threadId),
    privacyChanged() {
      // A held thread keeps its "not captured" reason until it is processed again, which could be
      // a backoff away; run it now so its status follows the new deny list.
      for (const st of states.values()) if (st.blocked !== null) schedule(st.id, 0);
    },
    isDenied: async thread => (await facts.denied(thread, await privacy())) !== null,

    async threadStatus(threadId): Promise<ThreadMemoryStatus> {
      const st = states.get(threadId);
      const thread = st?.thread ?? await (bb.sdk.threads.get({ threadId }) as Promise<Thread>).catch(() => undefined);
      const scope = (await bb.storage.kv.get<string>(scopeKey(threadId))) ?? null;
      const base = { threadId, lastUploadAt: st?.lastUploadAt ?? null, queued: st?.queued ?? 0, scope };
      if (st?.blocked) return { ...base, state: "not-captured", reason: st.blocked };
      const marker = outbox.switchOverMarker(threadId);
      if (marker === undefined && thread && !gateAlwaysOpen(thread.providerId) && await requiresSwitchover()) {
        // No scan has judged it yet (a new chat waits out the grace window): scan now, and don't
        // claim the harness is capturing before anyone has looked.
        if (!st?.gateScanned) { schedule(threadId, 0); return { ...base, state: "not-captured", reason: GATE_PENDING }; }
        return { ...base, state: "not-captured", reason: blockedReason(threadId) };
      }
      if (marker?.probation) return { ...base, state: "not-captured", reason: PROBATION };
      if (outbox.isPausedNow("thread", threadId) || (thread && outbox.isPausedNow("project", thread.projectId))) return { ...base, state: "paused" };
      if (outbox.retry(threadId)) return { ...base, state: "offline" };
      if ((st?.queued ?? 0) > 0 || outbox.inFlight(threadId).length) return { ...base, state: "saving" };
      return { ...base, state: "idle" };
    },

    async setPaused(target, paused) {
      const now = clock.now();
      if (target.kind === "project") { outbox.setPaused("project", target.id, paused, now, now); return; }
      const id = target.id;
      if (paused) {
        // The pause starts at the first seq not yet uploaded, so whatever is still waiting out the
        // grace window (or queued while offline) is stopped too; nothing already sent is touched.
        const floor = Math.min(outbox.cursor(id), ...outbox.inFlight(id).map(m => m.firstSeq - 1));
        outbox.setPaused("thread", id, true, Math.max(0, floor), now);
        return;
      }
      // Resume closes the range at the newest logged seq. If the log can't be read, close it at the
      // newest seq known here instead, and never below the range's start (that would drop it).
      const latest = await bb.sdk.threads.events.list({ threadId: id, order: "desc", limit: "1" }).then(rows => rows[0]?.seq ?? 0, () => undefined);
      let boundary = latest;
      if (boundary === undefined) {
        bb.log.warn(`honcho capture: resume of ${id} could not read the event log; closing the pause at the newest known seq`);
        boundary = Math.max(outbox.newestKnownSeq(id), states.get(id)?.seenSeq ?? 0, outbox.openPause("thread", id)?.from ?? 0);
      }
      outbox.setPaused("thread", id, false, boundary, now);
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

// Shared contract between the plugin's slices. Each slice implements one service and
// registers it through server.ts; the RPC layer and the UI only depend on these types.
// Change this file only together with every implementer (it is the parallel-build seam).

import type { ConfigResult } from "./config.js";
import type { HonchoClient, Conclusion } from "./honcho-client.js";
import type { Outbox } from "./outbox.js";

// ---------- activity (written by every slice, read by the Memory page) ----------

export type ActivityKind =
  | "upload" // a batch reached honcho
  | "recall" // instructions or a per-turn hook got memory
  | "tool" // an agent called a honcho_* tool
  | "delete" // a session or conclusions were deleted
  | "backfill"
  | "harness" // connect / hand over / undo / tripwire
  | "failure";

export interface ActivityEntry {
  id: number;
  at: number; // epoch ms
  kind: ActivityKind;
  threadId?: string;
  summary: string; // one line, already redacted
  messages?: number;
  redactions?: number;
  reasoning?: boolean;
  error?: string;
}

export interface ActivityLog {
  record(entry: Omit<ActivityEntry, "id" | "at">): void;
  list(opts?: { limit?: number; threadId?: string; kinds?: ActivityKind[] }): ActivityEntry[];
  subscribe(fn: (e: ActivityEntry) => void): () => void;
}

// ---------- shared deps handed to every slice ----------

export interface Deps {
  config(): Promise<ConfigResult>; // reads ~/.honcho/config.json live + bb overrides
  client(): Promise<HonchoClient>; // throws HonchoError("auth"|"offline") when unusable
  outbox: Outbox;
  activity: ActivityLog;
}

// ---------- capture ----------

export type ThreadMemoryState = "saving" | "paused" | "offline" | "idle" | "not-captured";

export interface ThreadMemoryStatus {
  threadId: string;
  state: ThreadMemoryState;
  lastUploadAt: number | null;
  queued: number;
  reason?: string; // e.g. "harness capture still active until the session rebuilds"
  scope: string | null;
}

export interface CaptureService {
  threadStatus(threadId: string): Promise<ThreadMemoryStatus>;
  setPaused(target: { kind: "thread" | "project"; id: string }, paused: boolean): Promise<void>;
  pauses(): Promise<Array<{ kind: "thread" | "project"; id: string; since: number }>>;
  health(): Promise<{ oldestPendingAt: number | null; queued: number; authFailing: boolean; tripwire: string | null }>;
  flushNow(): Promise<void>;
}

// ---------- recall + conclusions ----------

/** Who a conclusion comes from: "agent" (saved by honcho_conclude), "learned" (Honcho derived it from the user's
 * own messages) or "confirmed" (the user confirmed it). */
export type ConclusionOrigin = "agent" | "learned" | "confirmed";

export interface ConclusionView extends Conclusion {
  origin: ConclusionOrigin;
  /** Kept for compatibility: true only for origin "agent" (confirmed ones are "confirmed"). */
  agentWritten: boolean;
  confirmed: boolean;
}

export interface RecallService {
  threadContext(threadId: string): Promise<{ scope: string | null; top: ConclusionView[]; fromThread: ConclusionView[]; stale: boolean }>;
  conclusions(opts: { query?: string; scope?: string; limit?: number }): Promise<ConclusionView[]>;
  deleteConclusion(id: string): Promise<void>;
  confirmConclusion(id: string): Promise<void>;
}

// ---------- harness ----------

export interface HarnessState {
  machineId: string;
  claude: { hookInstalled: boolean; handedOver: boolean; pluginVersion: string | null };
  codex: { hookInstalled: boolean; handedOver: boolean; trusted: boolean | null };
  backups: string[];
}

export type HarnessUndoStep = "connect" | "handOver";

export interface HarnessService {
  state(machineId?: string): Promise<HarnessState>;
  connect(machineId?: string): Promise<HarnessState>; // installs the bb-gated hooks
  handOver(machineId?: string): Promise<HarnessState>; // disables claude-honcho / codex honcho, with backup
  /** Restores bb's backups for one step; no step undoes both connect and hand over. */
  undo(machineId?: string, step?: HarnessUndoStep): Promise<HarnessState>;
}

// ---------- backfill ----------

export interface BackfillPlan {
  threads: number;
  messages: number;
  tokens: number;
  skippedAlreadyInHoncho: number;
  /** pi/acp threads live capture hasn't seen yet: skipped, so the two never both upload one. */
  notYetSeenByCapture?: number;
  reasoningMessages: number;
}

export interface BackfillService {
  dryRun(opts?: { projectId?: string; since?: string }): Promise<BackfillPlan>;
  start(opts?: { projectId?: string; since?: string }): Promise<void>;
  progress(): Promise<{ running: boolean; done: number; total: number; error?: string }>;
  stop(): Promise<void>;
}

// ---------- privacy + connection (settings-backed) ----------

export interface PrivacySettings {
  denyRemotes: string[]; // glob on git remote url
  denyPaths: string[]; // glob on environment path
  patterns: string[]; // user regexes
  deleteOnDelete: boolean;
  purgeConclusionsOnDelete: boolean;
}

export interface ConnectionView {
  preset: "cloud" | "self-hosted";
  baseUrl: string;
  workspace: string;
  peerName: string;
  keySource: "config-file" | "bb-secret" | "none";
  keyLevel: "workspace-or-admin" | "restricted" | "unknown";
  warnings: string[];
}

export interface KeyNote {
  id: string; label: string; workspace: string; peer: string | null; session: string | null;
  scope: string | null; expiresAt: string | null; createdAt: number;
}
export interface KeyView {
  source: "config-file" | "bb-secret" | "none";
  level: "admin" | "workspace" | "assistant" | "session" | "group" | "unknown";
  workspace: string | null; activeWorkspace: string; expiresAt: string | null; notes: KeyNote[];
}
export interface MintKeyInput {
  label: string; workspace: string; peer?: string; session?: string; scope?: string; expiresAt?: string; adminKey?: string;
}
export interface GroupView { id: string; chats: number; lastActivity: number | null; paused: boolean }
export interface GroupDetail { summary: string; chats: Array<{ id: string; title: string | null; lastActivity: number }>; paused: boolean }
export interface ForgetGroupPlan { token: string; group: string; sessions: number; messages: number; conclusions: number; expiresAt: number }


// ---------- "from honcho" blocks in chats (Q45-Q48, 2026-11-15) ----------

/** One injection that really reached the agent: a per-turn hook hit the hook reported as served, or
 * the memory injected at a session (re)build. Misses, skips and paused threads never produce one. */
export interface MemoryInjection {
  kind: "turn" | "session";
  /** epoch ms: when the hook served it (turn) or the session was built (session) */
  at: number;
  scope: string | null;
  items: Array<{ content: string; date: string | null; sourceThreadId: string | null; sourceTitle: string | null }>;
  /** session only: the peer card / directives / scope summary lines that went in */
  card?: string[];
}

// ---------- RPC surface used by the frontend (method name -> [params, result]) ----------

export interface RpcMethods {
  "groups.list": [{}, GroupView[]];
  "groups.get": [{ group: string }, GroupDetail];
  "groups.search": [{ group: string; query: string }, Array<{ content: string; sessionId: string; date: string }>];
  "groups.ask": [{ group: string; query: string }, { content: string | null }];
  "groups.pause": [{ group: string; paused: boolean }, { ok: true }];
  "groups.forgetPreview": [{ group: string }, ForgetGroupPlan];
  "groups.forget": [{ group: string; confirmation: string; token: string }, { ok: true }];
  "learning.get": [{}, { pending: number; inProgress: number; lastRun: { status: string; at: string } | null }];
  "learning.consolidate": [{}, { ok: true }];
  "thread.summary": [{ threadId: string }, { content: string | null; at: string | null }];
  "keys.get": [{}, KeyView];
  "keys.replace": [{ apiKey: string | null }, { ok: true }];
  "keys.mint": [MintKeyInput, { key: string }];
  "thread.status": [{ threadId: string }, ThreadMemoryStatus];
  "thread.context": [{ threadId: string }, Awaited<ReturnType<RecallService["threadContext"]>>];
  "pause.set": [{ kind: "thread" | "project"; id: string; paused: boolean }, { ok: true }];
  "pause.list": [{}, Awaited<ReturnType<CaptureService["pauses"]>>];
  "health": [{}, Awaited<ReturnType<CaptureService["health"]>>];
  "activity.list": [{ limit?: number; threadId?: string; kinds?: ActivityKind[] }, ActivityEntry[]];
  "conclusions.list": [{ query?: string; scope?: string; limit?: number }, ConclusionView[]];
  "conclusions.delete": [{ id: string }, { ok: true }];
  "conclusions.confirm": [{ id: string }, { ok: true }];
  "peers.list": [{}, Array<{ providerId: string; peer: string; firstSeen: number | null }>];
  "peers.rename": [{ providerId: string; peer: string }, { ok: true }];
  "privacy.get": [{}, PrivacySettings];
  "privacy.set": [Partial<PrivacySettings>, PrivacySettings];
  "privacy.test": [{ text: string }, { text: string; count: number }];
  "connection.get": [{}, ConnectionView];
  "connection.test": [{}, { ok: boolean; latencyMs: number | null; error?: string }];
  "harness.state": [{ machineId?: string }, HarnessState];
  "harness.connect": [{ machineId?: string }, HarnessState];
  "harness.handOver": [{ machineId?: string }, HarnessState];
  "harness.undo": [{ machineId?: string; step?: HarnessUndoStep }, HarnessState];
  "backfill.dryRun": [{ projectId?: string; since?: string }, BackfillPlan];
  "backfill.start": [{ projectId?: string; since?: string }, { ok: true }];
  "backfill.progress": [{}, Awaited<ReturnType<BackfillService["progress"]>>];
  "backfill.stop": [{}, { ok: true }];
  /** injections for one thread, newest last, at most the last 200 */
  "recall.injections": [{ threadId: string; since?: number }, MemoryInjection[]];
  /** Read-only: chat titles and project names for ids the page would otherwise show raw. null = unknown. */
  "labels.get": [{ threadIds?: string[]; projectIds?: string[] }, { threads: Record<string, string | null>; projects: Record<string, string | null> }];
}

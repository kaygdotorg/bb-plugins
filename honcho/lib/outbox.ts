import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";

/** Append-only SQL. This database never stores event/message bodies. */
export const OUTBOX_MIGRATIONS = [
  `CREATE TABLE cursors (thread TEXT PRIMARY KEY, after_seq INTEGER NOT NULL CHECK(after_seq >= 0));
   CREATE TABLE in_flight (thread TEXT PRIMARY KEY, first_seq INTEGER NOT NULL, last_seq INTEGER NOT NULL,
     started_at INTEGER NOT NULL, CHECK(first_seq >= 0 AND last_seq >= first_seq));
   CREATE TABLE retries (thread TEXT PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts > 0),
     next_at INTEGER NOT NULL, last_error TEXT NOT NULL);
   CREATE TABLE switch_over (thread TEXT PRIMARY KEY, start_seq INTEGER NOT NULL CHECK(start_seq >= 0));
   CREATE TABLE pauses (kind TEXT NOT NULL CHECK(kind IN ('thread','project')), id TEXT NOT NULL,
     PRIMARY KEY(kind,id));`,
  // v2: pauses become ranges, plus fork boundaries, edit supersession and provider thread ids.
  // Old flag pauses have no position, so they become open ranges from the beginning.
  `CREATE TABLE pause_ranges (kind TEXT NOT NULL CHECK(kind IN ('thread','project')), id TEXT NOT NULL,
     from_value INTEGER NOT NULL CHECK(from_value >= 0), to_value INTEGER CHECK(to_value IS NULL OR to_value >= from_value));
   CREATE INDEX pause_ranges_target ON pause_ranges(kind, id);
   INSERT INTO pause_ranges SELECT kind, id, 0, NULL FROM pauses;
   DROP TABLE pauses;
   CREATE TABLE fork_sources (thread TEXT PRIMARY KEY, source_thread_id TEXT NOT NULL, boundary_seq INTEGER NOT NULL CHECK(boundary_seq >= 0));
   CREATE TABLE superseded (thread TEXT NOT NULL, from_seq INTEGER NOT NULL CHECK(from_seq >= 0),
     to_seq INTEGER NOT NULL CHECK(to_seq >= from_seq), PRIMARY KEY(thread, from_seq));
   CREATE TABLE provider_threads (thread TEXT NOT NULL, provider_thread_id TEXT NOT NULL, PRIMARY KEY(thread, provider_thread_id));`,
  // v3: when a pause started (epoch ms, shown on the Memory page) moves out of kv; plus a small meta table
  // (first_started_at: when the plugin first saw this database).
  `ALTER TABLE pause_ranges ADD COLUMN since_at INTEGER;
   UPDATE pause_ranges SET since_at=from_value WHERE kind='project';
   CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
] as const;
export interface InFlight { thread: string; firstSeq: number; lastSeq: number; startedAt: number }
export interface PauseRange { kind: "thread" | "project"; id: string; from: number; to: number | null; sinceAt: number | null }
export interface RetryState { attempts: number; nextAt: number; lastError: string }
export type RetryError = "auth" | "offline" | "rate-limited" | "validation" | "server" | "http";

export function migrateOutbox(db: Database.Database): void {
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS honcho_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const rows = db.prepare("SELECT version FROM honcho_migrations ORDER BY version").all() as Array<{ version: number }>;
    if (rows.some((row, index) => row.version !== index + 1) || rows.length > OUTBOX_MIGRATIONS.length) throw new Error("Unsupported Honcho outbox schema version.");
    for (let index = rows.length; index < OUTBOX_MIGRATIONS.length; index++) {
      db.exec(OUTBOX_MIGRATIONS[index]);
      db.prepare("INSERT INTO honcho_migrations VALUES (?,?)").run(index + 1, Date.now());
    }
  })();
}
function seq(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Sequence must be a nonnegative safe integer.");
}
export class Outbox {
  constructor(private readonly db: Database.Database) { migrateOutbox(db); }
  cursor(thread: string): number {
    return (this.db.prepare("SELECT after_seq FROM cursors WHERE thread=?").get(thread) as { after_seq: number } | undefined)?.after_seq ?? 0;
  }
  advance(thread: string, afterSeq: number): void {
    seq(afterSeq);
    this.db.prepare("INSERT INTO cursors VALUES (?,?) ON CONFLICT(thread) DO UPDATE SET after_seq=MAX(after_seq,excluded.after_seq)").run(thread, afterSeq);
  }
  begin(marker: InFlight): void {
    seq(marker.firstSeq); seq(marker.lastSeq);
    if (marker.lastSeq < marker.firstSeq) throw new Error("Invalid in-flight sequence range.");
    // INSERT rejects an unresolved marker, preventing silent loss of crash recovery state.
    this.db.prepare("INSERT INTO in_flight VALUES (?,?,?,?)").run(marker.thread, marker.firstSeq, marker.lastSeq, marker.startedAt);
  }
  inFlight(thread?: string): InFlight[] {
    const rows = (thread === undefined ? this.db.prepare("SELECT * FROM in_flight ORDER BY started_at,thread").all()
      : this.db.prepare("SELECT * FROM in_flight WHERE thread=?").all(thread)) as Array<{ thread: string; first_seq: number; last_seq: number; started_at: number }>;
    return rows.map(r => ({ thread: r.thread, firstSeq: r.first_seq, lastSeq: r.last_seq, startedAt: r.started_at }));
  }
  /** Call only after a successful POST or metadata reconciliation. */
  complete(thread: string, afterSeq: number): void {
    seq(afterSeq);
    this.db.transaction(() => {
      const marker = this.inFlight(thread)[0];
      if (!marker || afterSeq !== marker.lastSeq) throw new Error("Completion must match the in-flight range.");
      this.advance(thread, afterSeq);
      this.db.prepare("DELETE FROM in_flight WHERE thread=?").run(thread);
      this.db.prepare("DELETE FROM retries WHERE thread=?").run(thread);
    })();
  }
  retry(thread: string): RetryState | undefined {
    const row = this.db.prepare("SELECT * FROM retries WHERE thread=?").get(thread) as { attempts: number; next_at: number; last_error: string } | undefined;
    return row && { attempts: row.attempts, nextAt: row.next_at, lastError: row.last_error };
  }
  /** Store only an error category, never arbitrary error text or message content. */
  fail(thread: string, kind: RetryError, now: number): RetryState {
    const allowed: RetryError[] = ["auth", "offline", "rate-limited", "validation", "server", "http"];
    const lastError = allowed.includes(kind) ? kind : "offline";
    const attempts = (this.retry(thread)?.attempts ?? 0) + 1;
    const nextAt = now + Math.min(300_000, 1_000 * 2 ** Math.min(attempts - 1, 20));
    this.db.prepare("INSERT INTO retries VALUES (?,?,?,?) ON CONFLICT(thread) DO UPDATE SET attempts=excluded.attempts,next_at=excluded.next_at,last_error=excluded.last_error").run(thread, attempts, nextAt, lastError);
    return { attempts, nextAt, lastError };
  }
  /** Drops retry/backoff state without touching the cursor. */
  clearRetry(thread: string): void {
    this.db.prepare("DELETE FROM retries WHERE thread=?").run(thread);
  }
  /** Write-once meta value; returns the stored one (the first writer wins). */
  setMetaOnce(key: string, value: string): string {
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES (?,?)").run(key, value);
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string }).value;
  }
  meta(key: string): string | undefined {
    return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined)?.value;
  }
  /** Epoch ms the plugin first started against this database; recorded once. */
  recordFirstStart(now: number): number {
    return Number(this.setMetaOnce("first_started_at", String(now)));
  }
  markSwitchOver(thread: string, startSeq: number): void {
    seq(startSeq);
    this.db.prepare("INSERT INTO switch_over VALUES (?,?) ON CONFLICT(thread) DO NOTHING").run(thread, startSeq);
  }
  switchOver(thread: string): number | undefined {
    return (this.db.prepare("SELECT start_seq FROM switch_over WHERE thread=?").get(thread) as { start_seq: number } | undefined)?.start_seq;
  }
  /** Pauses are inclusive ranges, closed or open at the end, checked when an item is about to be sent.
   * A thread pause is a seq range. Seqs are per thread, so a project pause is a range of event
   * createdAt (epoch ms) instead, applied to every thread in the project.
   * `boundary` is the newest seq already seen on the thread (thread kind) or the current time
   * (project kind): pausing covers everything after it, resuming closes the range at it.
   * `sinceAt` is the wall-clock time the pause began, stored with the range. */
  setPaused(kind: "thread" | "project", id: string, paused: boolean, boundary: number, sinceAt: number = Date.now()): void {
    seq(boundary);
    this.db.transaction(() => {
      const open = this.db.prepare("SELECT from_value FROM pause_ranges WHERE kind=? AND id=? AND to_value IS NULL").get(kind, id) as { from_value: number } | undefined;
      if (paused) {
        if (!open) this.db.prepare("INSERT INTO pause_ranges (kind,id,from_value,to_value,since_at) VALUES (?,?,?,NULL,?)").run(kind, id, kind === "thread" ? boundary + 1 : boundary, sinceAt);
        return;
      }
      if (!open) return;
      const to = boundary;
      if (to < open.from_value) this.db.prepare("DELETE FROM pause_ranges WHERE kind=? AND id=? AND to_value IS NULL").run(kind, id);
      else this.db.prepare("UPDATE pause_ranges SET to_value=? WHERE kind=? AND id=? AND to_value IS NULL").run(to, kind, id);
    })();
  }
  /** Whether the event at `seq` (created at `createdAt`) falls in a thread or project pause range. */
  isPaused(thread: string, seqNumber: number, project?: { id: string; createdAt: number }): boolean {
    const covers = this.db.prepare("SELECT 1 FROM pause_ranges WHERE kind=? AND id=? AND from_value<=? AND (to_value IS NULL OR to_value>=?) LIMIT 1");
    return !!covers.get("thread", thread, seqNumber, seqNumber) || (project !== undefined && !!covers.get("project", project.id, project.createdAt, project.createdAt));
  }
  /** Whether new events are being paused right now. */
  isPausedNow(kind: "thread" | "project", id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pause_ranges WHERE kind=? AND id=? AND to_value IS NULL").get(kind, id);
  }
  pauses(): PauseRange[] {
    return (this.db.prepare("SELECT kind,id,from_value,to_value,since_at FROM pause_ranges ORDER BY kind,id,from_value").all() as Array<{ kind: "thread" | "project"; id: string; from_value: number; to_value: number | null; since_at: number | null }>)
      .map(r => ({ kind: r.kind, id: r.id, from: r.from_value, to: r.to_value, sinceAt: r.since_at }));
  }
  /** Forks and side chats copy the parent's completed-turn events: their cursor starts after the last copied seq. */
  setForkSource(thread: string, sourceThreadId: string, boundarySeq: number): void {
    seq(boundarySeq);
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO fork_sources VALUES (?,?,?) ON CONFLICT(thread) DO NOTHING").run(thread, sourceThreadId, boundarySeq);
      this.advance(thread, this.forkSource(thread)!.boundarySeq);
    })();
  }
  forkSource(thread: string): { sourceThreadId: string; boundarySeq: number } | undefined {
    const row = this.db.prepare("SELECT source_thread_id, boundary_seq FROM fork_sources WHERE thread=?").get(thread) as { source_thread_id: string; boundary_seq: number } | undefined;
    return row && { sourceThreadId: row.source_thread_id, boundarySeq: row.boundary_seq };
  }
  /** A message edit deleted seqs [fromSeq, toSeq] from the log. Queued items in the range are dropped, not retried. */
  supersede(thread: string, fromSeq: number, toSeq: number): void {
    seq(fromSeq); seq(toSeq);
    if (toSeq < fromSeq) throw new Error("Invalid superseded range.");
    this.db.prepare("INSERT INTO superseded VALUES (?,?,?) ON CONFLICT(thread,from_seq) DO UPDATE SET to_seq=MAX(to_seq,excluded.to_seq)").run(thread, fromSeq, toSeq);
  }
  isSuperseded(thread: string, seqNumber: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM superseded WHERE thread=? AND from_seq<=? AND to_seq>=? LIMIT 1").get(thread, seqNumber, seqNumber);
  }
  supersededRanges(thread: string): Array<{ from: number; to: number }> {
    return (this.db.prepare("SELECT from_seq,to_seq FROM superseded WHERE thread=? ORDER BY from_seq").all(thread) as Array<{ from_seq: number; to_seq: number }>).map(r => ({ from: r.from_seq, to: r.to_seq }));
  }
  /** Send-time gate: false when the seq is paused or superseded. */
  shouldSend(thread: string, seqNumber: number, project?: { id: string; createdAt: number }): boolean {
    return !this.isSuperseded(thread, seqNumber) && !this.isPaused(thread, seqNumber, project);
  }
  /** thread/identity.providerThreadId; a thread can have several. */
  addProviderThread(thread: string, providerThreadId: string): void {
    if (!providerThreadId) return;
    this.db.prepare("INSERT OR IGNORE INTO provider_threads VALUES (?,?)").run(thread, providerThreadId);
  }
  providerThreads(thread: string): string[] {
    return (this.db.prepare("SELECT provider_thread_id FROM provider_threads WHERE thread=? ORDER BY rowid").all(thread) as Array<{ provider_thread_id: string }>).map(r => r.provider_thread_id);
  }
  /** Removes the thread's state, including its pause ranges. Project pauses stay. */
  deleteThread(thread: string): void {
    this.db.transaction(() => {
      for (const table of ["cursors", "in_flight", "retries", "switch_over", "fork_sources", "superseded", "provider_threads"]) this.db.prepare(`DELETE FROM ${table} WHERE thread=?`).run(thread);
      this.db.prepare("DELETE FROM pause_ranges WHERE kind='thread' AND id=?").run(thread);
    })();
  }
}
/** Later wiring owns disposal; bb tracks and closes this database on reload. */
export function openOutbox(storage: Pick<BbPluginApi["storage"], "database">): Outbox {
  return new Outbox(storage.database());
}

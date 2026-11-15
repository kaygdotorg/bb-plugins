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
] as const;
export interface InFlight { thread: string; firstSeq: number; lastSeq: number; startedAt: number }
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
  markSwitchOver(thread: string, startSeq: number): void {
    seq(startSeq);
    this.db.prepare("INSERT INTO switch_over VALUES (?,?) ON CONFLICT(thread) DO NOTHING").run(thread, startSeq);
  }
  switchOver(thread: string): number | undefined {
    return (this.db.prepare("SELECT start_seq FROM switch_over WHERE thread=?").get(thread) as { start_seq: number } | undefined)?.start_seq;
  }
  setPaused(kind: "thread" | "project", id: string, paused: boolean): void {
    if (paused) this.db.prepare("INSERT OR IGNORE INTO pauses VALUES (?,?)").run(kind, id);
    else this.db.prepare("DELETE FROM pauses WHERE kind=? AND id=?").run(kind, id);
  }
  isPaused(thread: string, project?: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM pauses WHERE (kind='thread' AND id=?) OR (kind='project' AND id=?) LIMIT 1").get(thread, project ?? null);
  }
  deleteThread(thread: string): void {
    this.db.transaction(() => {
      for (const table of ["cursors", "in_flight", "retries", "switch_over"]) this.db.prepare(`DELETE FROM ${table} WHERE thread=?`).run(thread);
      this.db.prepare("DELETE FROM pauses WHERE kind='thread' AND id=?").run(thread);
    })();
  }
}
/** Later wiring owns disposal; bb tracks and closes this database on reload. */
export function openOutbox(storage: Pick<BbPluginApi["storage"], "database">): Outbox {
  return new Outbox(storage.database());
}

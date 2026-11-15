import type Database from "better-sqlite3";

/**
 * Backfill's own tables in the plugin database (`bb.storage.database()`).
 * Why not `Outbox`'s db: the handle is private to Outbox, and its append-only
 * migration list belongs to the capture slice, so adding tables there would couple
 * two slices' schemas. Why not `bb.storage.migrate`: it keys migrations by statement
 * index in one shared `_bb_migrations` table, which would collide with other slices.
 * So this file keeps a private version table. Content-free: only seqs and counts.
 */
export const BACKFILL_MIGRATIONS = [
  `CREATE TABLE backfill_threads (thread TEXT PRIMARY KEY, after_seq INTEGER NOT NULL CHECK(after_seq >= 0),
     uploaded INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
   CREATE TABLE backfill_run (id INTEGER PRIMARY KEY CHECK(id = 1), done INTEGER NOT NULL, total INTEGER NOT NULL,
     error TEXT, started_at INTEGER, finished_at INTEGER);`,
] as const;

export interface RunRow { done: number; total: number; error?: string; startedAt: number | null; finishedAt: number | null }

export class BackfillStore {
  constructor(private readonly db: Database.Database) {
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS honcho_backfill_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      const rows = db.prepare("SELECT version FROM honcho_backfill_migrations ORDER BY version").all() as Array<{ version: number }>;
      if (rows.some((r, i) => r.version !== i + 1) || rows.length > BACKFILL_MIGRATIONS.length) throw new Error("Unsupported Honcho backfill schema version.");
      for (let i = rows.length; i < BACKFILL_MIGRATIONS.length; i++) {
        db.exec(BACKFILL_MIGRATIONS[i]);
        db.prepare("INSERT INTO honcho_backfill_migrations VALUES (?,?)").run(i + 1, Date.now());
      }
    })();
  }
  cursor(thread: string): number {
    return (this.db.prepare("SELECT after_seq FROM backfill_threads WHERE thread=?").get(thread) as { after_seq: number } | undefined)?.after_seq ?? 0;
  }
  /** Monotonic: a cursor never moves back. */
  advance(thread: string, afterSeq: number, uploadedDelta = 0, now = Date.now()): void {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new Error("Sequence must be a nonnegative safe integer.");
    this.db.prepare(`INSERT INTO backfill_threads VALUES (?,?,?,?) ON CONFLICT(thread) DO UPDATE SET
      after_seq=MAX(after_seq,excluded.after_seq), uploaded=uploaded+excluded.uploaded, updated_at=excluded.updated_at`).run(thread, afterSeq, uploadedDelta, now);
  }
  uploaded(thread: string): number {
    return (this.db.prepare("SELECT uploaded FROM backfill_threads WHERE thread=?").get(thread) as { uploaded: number } | undefined)?.uploaded ?? 0;
  }
  run(): RunRow {
    const r = this.db.prepare("SELECT * FROM backfill_run WHERE id=1").get() as { done: number; total: number; error: string | null; started_at: number | null; finished_at: number | null } | undefined;
    return r ? { done: r.done, total: r.total, ...(r.error ? { error: r.error } : {}), startedAt: r.started_at, finishedAt: r.finished_at } : { done: 0, total: 0, startedAt: null, finishedAt: null };
  }
  beginRun(now: number): void {
    this.db.prepare("INSERT INTO backfill_run VALUES (1,0,0,NULL,?,NULL) ON CONFLICT(id) DO UPDATE SET done=0,total=0,error=NULL,started_at=excluded.started_at,finished_at=NULL").run(now);
  }
  updateRun(done: number, total: number): void {
    this.db.prepare("UPDATE backfill_run SET done=?, total=? WHERE id=1").run(done, total);
  }
  finishRun(now: number, error?: string): void {
    this.db.prepare("UPDATE backfill_run SET error=?, finished_at=? WHERE id=1").run(error ?? null, now);
  }
}

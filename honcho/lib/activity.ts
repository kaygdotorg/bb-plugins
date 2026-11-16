import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import type { ActivityEntry, ActivityKind, ActivityLog } from "./contract.js";

export const ACTIVITY_CAPACITY = 2000;

/** In-memory ring buffer of recent activity (tests, and the fallback when the database is unusable).
 * Summaries are already redacted by the callers. */
export class RingActivityLog implements ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private readonly listeners = new Set<(entry: ActivityEntry) => void>();
  private nextId = 1;
  constructor(private readonly capacity = ACTIVITY_CAPACITY, private readonly clock: () => number = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Activity capacity must be a positive integer.");
  }
  record(entry: Omit<ActivityEntry, "id" | "at">): void {
    const stored: ActivityEntry = { ...entry, id: this.nextId++, at: this.clock() };
    this.entries.push(stored);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    // A misbehaving listener must never break capture.
    for (const listener of [...this.listeners]) { try { listener({ ...stored }); } catch { /* ignore */ } }
  }
  /** Newest first. */
  list(opts: { limit?: number; threadId?: string; kinds?: ActivityKind[] } = {}): ActivityEntry[] {
    const out: ActivityEntry[] = [];
    const limit = opts.limit ?? this.capacity;
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (opts.threadId !== undefined && e.threadId !== opts.threadId) continue;
      if (opts.kinds && !opts.kinds.includes(e.kind)) continue;
      out.push({ ...e });
    }
    return out;
  }
  subscribe(fn: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

/** Append-only SQL, versioned separately from the outbox's. Rows hold the already-redacted one-line
 * summary and counts only, never message content. */
export const ACTIVITY_MIGRATIONS = [
  `CREATE TABLE activity (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, thread TEXT,
     summary TEXT NOT NULL, msg_count INTEGER, redaction_count INTEGER, reasoning INTEGER, error TEXT);
   CREATE INDEX activity_thread ON activity(thread, id);`,
] as const;

export function migrateActivity(db: Database.Database): void {
  db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS activity_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
    const done = (db.prepare("SELECT COUNT(*) AS n FROM activity_migrations").get() as { n: number }).n;
    if (done > ACTIVITY_MIGRATIONS.length) throw new Error("Unsupported Honcho activity schema version.");
    for (let index = done; index < ACTIVITY_MIGRATIONS.length; index++) {
      db.exec(ACTIVITY_MIGRATIONS[index]);
      db.prepare("INSERT INTO activity_migrations VALUES (?,?)").run(index + 1, Date.now());
    }
  })();
}

interface Row { id: number; at: number; kind: ActivityKind; thread: string | null; summary: string; msg_count: number | null; redaction_count: number | null; reasoning: number | null; error: string | null }

/** The activity log in the plugin's sqlite: survives reloads, keeps the newest `capacity` rows. */
export class SqliteActivityLog implements ActivityLog {
  private readonly listeners = new Set<(entry: ActivityEntry) => void>();
  constructor(private readonly db: Database.Database, private readonly capacity = ACTIVITY_CAPACITY, private readonly clock: () => number = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Activity capacity must be a positive integer.");
    migrateActivity(db);
  }
  record(entry: Omit<ActivityEntry, "id" | "at">): void {
    const at = this.clock();
    let id: number;
    try {
      id = Number(this.db.prepare("INSERT INTO activity (at,kind,thread,summary,msg_count,redaction_count,reasoning,error) VALUES (?,?,?,?,?,?,?,?)").run(
        at, entry.kind, entry.threadId ?? null, entry.summary, entry.messages ?? null, entry.redactions ?? null,
        entry.reasoning === undefined ? null : entry.reasoning ? 1 : 0, entry.error ?? null).lastInsertRowid);
      this.db.prepare("DELETE FROM activity WHERE id <= ?").run(id - this.capacity);
    } catch { return; } // A full or locked disk must never break capture.
    const stored: ActivityEntry = { ...entry, id, at };
    for (const listener of [...this.listeners]) { try { listener({ ...stored }); } catch { /* ignore */ } }
  }
  /** Newest first. */
  list(opts: { limit?: number; threadId?: string; kinds?: ActivityKind[] } = {}): ActivityEntry[] {
    const limit = opts.limit ?? this.capacity;
    if (limit <= 0) return [];
    const where: string[] = []; const args: Array<string | number> = [];
    if (opts.threadId !== undefined) { where.push("thread = ?"); args.push(opts.threadId); }
    if (opts.kinds) { if (!opts.kinds.length) return []; where.push(`kind IN (${opts.kinds.map(() => "?").join(",")})`); args.push(...opts.kinds); }
    let rows: Row[];
    try {
      rows = this.db.prepare(`SELECT * FROM activity ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`).all(...args, limit) as Row[];
    } catch { return []; }
    return rows.map(r => {
      const e: ActivityEntry = { id: r.id, at: r.at, kind: r.kind, summary: r.summary };
      if (r.thread !== null) e.threadId = r.thread;
      if (r.msg_count !== null) e.messages = r.msg_count;
      if (r.redaction_count !== null) e.redactions = r.redaction_count;
      if (r.reasoning !== null) e.reasoning = r.reasoning === 1;
      if (r.error !== null) e.error = r.error;
      return e;
    });
  }
  subscribe(fn: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}
export function openActivityLog(storage: Pick<BbPluginApi["storage"], "database">, clock?: () => number): SqliteActivityLog {
  return new SqliteActivityLog(storage.database(), ACTIVITY_CAPACITY, clock);
}

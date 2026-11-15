import type Database from "better-sqlite3";

/**
 * Agent-written / confirmed state for conclusions. Honcho v3 conclusions carry
 * no metadata and have no update endpoint, so this cannot live in Honcho; it is
 * a local table keyed by conclusion id. No conclusion content is stored here.
 */
export const RECALL_MIGRATIONS = [
  `CREATE TABLE recall_conclusion_marks (id TEXT PRIMARY KEY,
     agent_written INTEGER NOT NULL DEFAULT 0 CHECK(agent_written IN (0,1)),
     confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1)),
     thread TEXT, scope TEXT, marked_at INTEGER NOT NULL);
   CREATE INDEX recall_marks_thread ON recall_conclusion_marks(thread);`,
  // 0 when the conclusion was saved without a session_id: deleting the thread's session does not
  // remove it, so the delete path purges it by id (conclusionsForThread).
  `ALTER TABLE recall_conclusion_marks ADD COLUMN attached INTEGER NOT NULL DEFAULT 1 CHECK(attached IN (0,1));`,
] as const;

export interface ConclusionMark { id: string; agentWritten: boolean; confirmed: boolean; thread: string | null; scope: string | null }
interface Row { id: string; agent_written: number; confirmed: number; thread: string | null; scope: string | null }
const mark = (r: Row): ConclusionMark => ({ id: r.id, agentWritten: r.agent_written === 1, confirmed: r.confirmed === 1, thread: r.thread, scope: r.scope });

export class RecallStore {
  constructor(private readonly db: Database.Database) {
    db.transaction(() => {
      db.exec("CREATE TABLE IF NOT EXISTS recall_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
      const rows = db.prepare("SELECT version FROM recall_migrations ORDER BY version").all() as Array<{ version: number }>;
      if (rows.some((row, i) => row.version !== i + 1) || rows.length > RECALL_MIGRATIONS.length) throw new Error("Unsupported Honcho recall schema version.");
      for (let i = rows.length; i < RECALL_MIGRATIONS.length; i++) {
        db.exec(RECALL_MIGRATIONS[i]);
        db.prepare("INSERT INTO recall_migrations VALUES (?,?)").run(i + 1, Date.now());
      }
    })();
  }
  markAgentWritten(id: string, thread: string | null, scope: string | null, attached = true): void {
    this.db.prepare(`INSERT INTO recall_conclusion_marks (id,agent_written,thread,scope,marked_at,attached) VALUES (?,1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET agent_written=1, thread=COALESCE(thread,excluded.thread), scope=COALESCE(scope,excluded.scope),
        attached=MIN(attached,excluded.attached)`).run(id, thread, scope, Date.now(), attached ? 1 : 0);
  }
  /** Conclusions saved from a thread, and whether each carries the thread's session_id. */
  conclusionsForThread(thread: string): Array<{ id: string; attached: boolean }> {
    return (this.db.prepare("SELECT id, attached FROM recall_conclusion_marks WHERE thread=? ORDER BY marked_at").all(thread) as Array<{ id: string; attached: number }>)
      .map(r => ({ id: r.id, attached: r.attached === 1 }));
  }
  confirm(id: string): void {
    this.db.prepare(`INSERT INTO recall_conclusion_marks (id,confirmed,marked_at) VALUES (?,1,?)
      ON CONFLICT(id) DO UPDATE SET confirmed=1`).run(id, Date.now());
  }
  forget(id: string): void { this.db.prepare("DELETE FROM recall_conclusion_marks WHERE id=?").run(id); }
  get(id: string): ConclusionMark | null {
    const row = this.db.prepare("SELECT * FROM recall_conclusion_marks WHERE id=?").get(id) as Row | undefined;
    return row ? mark(row) : null;
  }
  many(ids: readonly string[]): Map<string, ConclusionMark> {
    const out = new Map<string, ConclusionMark>();
    const stmt = this.db.prepare("SELECT * FROM recall_conclusion_marks WHERE id=?");
    for (const id of ids) { const row = stmt.get(id) as Row | undefined; if (row) out.set(id, mark(row)); }
    return out;
  }
  forThread(thread: string): ConclusionMark[] {
    return (this.db.prepare("SELECT * FROM recall_conclusion_marks WHERE thread=? ORDER BY marked_at").all(thread) as Row[]).map(mark);
  }
  agentWrittenInScope(scope: string): ConclusionMark[] {
    return (this.db.prepare("SELECT * FROM recall_conclusion_marks WHERE scope=? AND agent_written=1 ORDER BY marked_at DESC").all(scope) as Row[]).map(mark);
  }
}

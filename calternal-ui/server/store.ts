/**
 * Persistence: one small key/value table in the plugin's own SQLite database, plus the
 * settings document stored under "prefs". Every write bumps "updatedAt", which the app
 * uses to notice changes.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { prefsSchema, type FramePrefs } from "../shared/contract";
import { DEFAULT_PREFS } from "../shared/defaults";

export type Db = ReturnType<BbPluginApi["storage"]["database"]>;

/** Ordered migrations; append only (bb records each statement's hash). */
const MIGRATIONS = [
  "CREATE TABLE frame_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  "CREATE TABLE wallpapers (id TEXT PRIMARY KEY, source TEXT NOT NULL, data TEXT NOT NULL, thumb TEXT, credit TEXT, added_at INTEGER NOT NULL)",
];

export function createStore(bb: BbPluginApi) {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const readStmt = db.prepare<[string], { value: string }>("SELECT value FROM frame_kv WHERE key = ?");
  const writeStmt = db.prepare<[string, string]>(
    "INSERT INTO frame_kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const removeStmt = db.prepare<[string]>("DELETE FROM frame_kv WHERE key = ?");

  const get = (key: string): string | undefined => readStmt.get(key)?.value;
  const touch = () => writeStmt.run("updatedAt", String(Date.now()));
  const set = (key: string, value: string) => { writeStmt.run(key, value); touch(); };
  const remove = (key: string) => { removeStmt.run(key); touch(); };

  /** The stored settings merged over the defaults; unknown keys from older versions drop out. */
  function prefs(): FramePrefs {
    const stored = get("prefs");
    const parsed = stored ? prefsSchema.partial().safeParse(JSON.parse(stored)) : null;
    const p = parsed?.success ? parsed.data : {};
    const d = DEFAULT_PREFS;
    return {
      wallpaperUrl: p.wallpaperUrl ?? d.wallpaperUrl,
      wallpaperCredit: p.wallpaperCredit ?? null,
      sidebar: { ...d.sidebar, ...p.sidebar },
      chat: { ...d.chat, ...p.chat },
      fonts: { ...d.fonts, ...p.fonts },
      uiScale: p.uiScale ?? d.uiScale,
      clock: p.clock ?? d.clock,
      chatWidth: p.chatWidth ?? d.chatWidth,
      accent: p.accent ?? d.accent,
    };
  }

  const savePrefs = (next: FramePrefs) => set("prefs", JSON.stringify(next));
  const updatedAt = () => Number(get("updatedAt") ?? 0);

  /**
   * Gives deleted downloads' space back to the disk: SQLite keeps freed pages otherwise.
   * The database is a few MB at most, so this takes milliseconds.
   */
  const vacuum = () => {
    try {
      db.exec("VACUUM");
      // bb's databases use WAL: VACUUM's compact copy lands in the log, and the file only
      // shrinks at a checkpoint. Truncate now so the space is back as soon as you click.
      db.pragma("wal_checkpoint(TRUNCATE)");
    } catch { /* busy: the next removal retries */ }
  };

  return { db, get, set, remove, touch, prefs, savePrefs, updatedAt, vacuum };
}

export type Store = ReturnType<typeof createStore>;

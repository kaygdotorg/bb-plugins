/**
 * The local wallpaper library. Every upload and Unsplash download is stored once (full
 * image + a small thumbnail); switching between stored wallpapers needs no network.
 * The active image is copied to the "wallpaper" key so reading it stays one lookup.
 */
import { createHash } from "node:crypto";
import type { LibraryEntry, FramePrefs } from "../shared/contract";
import type { Store } from "./store";

type Credit = FramePrefs["wallpaperCredit"];
type Row = { id: string; source: "upload" | "unsplash"; data: string; thumb: string | null; credit: string | null; added_at: number };

/** Uploads are keyed by content, so the same image uploaded twice is stored once. */
export const uploadId = (dataUrl: string) => `upload:${createHash("sha1").update(dataUrl).digest("hex").slice(0, 16)}`;
export const unsplashId = (photoId: string) => `unsplash:${photoId}`;

export function createWallpapers(store: Store) {
  const { db } = store;
  const getRow = db.prepare<[string], Row>("SELECT * FROM wallpapers WHERE id = ?");
  const listRows = db.prepare<[], Omit<Row, "data">>(
    "SELECT id, source, thumb, credit, added_at FROM wallpapers ORDER BY added_at DESC",
  );
  const putRow = db.prepare<[string, string, string, string | null, string | null, number]>(
    `INSERT INTO wallpapers (id, source, data, thumb, credit, added_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET thumb = COALESCE(excluded.thumb, wallpapers.thumb)`,
  );
  const setThumbRow = db.prepare<[string, string]>("UPDATE wallpapers SET thumb = ? WHERE id = ?");
  const deleteRow = db.prepare<[string]>("DELETE FROM wallpapers WHERE id = ?");

  const activeId = () => store.get("wallpaperActive");

  function add(id: string, source: Row["source"], data: string, thumb: string | null, credit: Credit) {
    putRow.run(id, source, data, thumb, credit ? JSON.stringify(credit) : null, Date.now());
  }

  /** Makes a stored wallpaper the active one; false when it is not stored. */
  function activate(id: string): boolean {
    const row = getRow.get(id);
    if (!row) return false;
    store.set("wallpaper", row.data);
    store.set("wallpaperActive", id);
    store.savePrefs({ ...store.prefs(), wallpaperCredit: row.credit ? JSON.parse(row.credit) : null });
    return true;
  }

  /** Shows no wallpaper; the library keeps everything. */
  function clearActive() {
    store.remove("wallpaper");
    store.remove("wallpaperActive");
    store.savePrefs({ ...store.prefs(), wallpaperCredit: null });
  }

  function list(): LibraryEntry[] {
    const active = activeId();
    return listRows.all().map((r: Omit<Row, "data">) => ({
      id: r.id,
      source: r.source,
      thumb: r.thumb,
      credit: r.credit ? JSON.parse(r.credit) : null,
      addedAt: r.added_at,
      active: r.id === active,
    }));
  }

  function remove(id: string) {
    deleteRow.run(id);
    if (activeId() === id) clearActive();
  }

  const fullImage = (id: string) => getRow.get(id)?.data;
  const setThumb = (id: string, thumb: string) => setThumbRow.run(thumb, id);

  /** 0.1.x kept only the active wallpaper: file it in the library once. */
  function migrateLegacy() {
    const current = store.get("wallpaper");
    if (!current || activeId()) return;
    const credit = store.prefs().wallpaperCredit;
    const id = uploadId(current);
    add(id, credit ? "unsplash" : "upload", current, null, credit);
    store.set("wallpaperActive", id);
  }

  return { add, activate, clearActive, list, remove, fullImage, setThumb, migrateLegacy };
}

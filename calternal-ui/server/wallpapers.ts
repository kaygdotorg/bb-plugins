/**
 * The local wallpaper library. Every upload and Unsplash download is stored once (full
 * image + a small thumbnail); switching between stored wallpapers needs no network.
 * "wallpaperActive" names the active row; the image itself is stored only in the table.
 */
import { createHash } from "node:crypto";
import type { LibraryEntry, FramePrefs } from "../shared/contract";
import type { Store } from "./store";

type Credit = FramePrefs["wallpaperCredit"];
type Row = { id: string; source: "upload" | "unsplash"; data: string; thumb: string | null; credit: string | null; added_at: number };
type SizeRow = Omit<Row, "data"> & { bytes: number };

/** A base64 data URL's decoded size, near enough for a storage list. */
export const dataUrlBytes = (chars: number) => Math.round(chars * 0.75);

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
  const sizeRows = db.prepare<[], SizeRow>(
    `SELECT id, source, thumb, credit, added_at, length(data) + COALESCE(length(thumb), 0) AS bytes
     FROM wallpapers ORDER BY added_at DESC`,
  );

  const activeId = () => store.get("wallpaperActive");

  function add(id: string, source: Row["source"], data: string, thumb: string | null, credit: Credit) {
    putRow.run(id, source, data, thumb, credit ? JSON.stringify(credit) : null, Date.now());
  }

  /** Makes a stored wallpaper the active one; false when it is not stored. */
  function activate(id: string): boolean {
    const row = getRow.get(id);
    if (!row) return false;
    store.set("wallpaperActive", id);
    store.savePrefs({ ...store.prefs(), wallpaperCredit: row.credit ? JSON.parse(row.credit) : null });
    return true;
  }

  /** Shows no wallpaper; the library keeps everything. */
  function clearActive() {
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

  /** Deletes a stored wallpaper for good; deleting the active one shows no wallpaper. */
  function remove(id: string) {
    deleteRow.run(id);
    if (activeId() === id) clearActive();
    else store.touch(); // the app re-reads the library when updatedAt moves
  }

  /** Every stored wallpaper with its size, for the storage list. */
  function sizes() {
    const active = activeId();
    return sizeRows.all().map((r: SizeRow) => ({
      id: r.id,
      source: r.source,
      thumb: r.thumb,
      credit: r.credit ? JSON.parse(r.credit) as Credit : null,
      bytes: dataUrlBytes(r.bytes),
      active: r.id === active,
    }));
  }

  const fullImage = (id: string) => getRow.get(id)?.data;
  /** The active image, or undefined when none is set. */
  const activeData = () => { const id = activeId(); return id ? getRow.get(id)?.data : undefined; };
  const setThumb = (id: string, thumb: string) => setThumbRow.run(thumb, id);

  /**
   * Older versions kept a copy of the active image under "wallpaper" (0.1.x: only that). File
   * it in the library if it is not there yet, then drop the copy so the image is stored once.
   */
  function migrateLegacy() {
    const current = store.get("wallpaper");
    if (!current) return;
    const active = activeId();
    if (!active || !getRow.get(active)) {
      const credit = store.prefs().wallpaperCredit;
      const id = active ?? uploadId(current);
      add(id, credit ? "unsplash" : "upload", current, null, credit);
      store.set("wallpaperActive", id);
    }
    store.remove("wallpaper");
    store.vacuum();
  }

  return { add, activate, clearActive, list, remove, sizes, fullImage, activeData, setThumb, migrateLegacy };
}

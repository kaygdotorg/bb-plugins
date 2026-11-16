/**
 * Fonts: the picker's catalogue and local installs, over several sources (2026-11-16):
 * Google Fonts (fonts-google), Fontsource's non-Google families (fonts-fontsource),
 * Fontshare (fonts-fontshare) and your own uploads (fonts-upload). "System" is the device's
 * font and is never installed (shared/fonts.ts).
 *
 * A chosen family is downloaded once (woff2, weights 400–700), its files inlined as data URLs
 * into @font-face CSS and stored under `font:<family>`, tagged with its source; bb then serves
 * fonts with no third-party requests. Prefs keep only the family name: the source is found by
 * looking the name up (Google first), so selections saved before other sources existed still work.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { CatalogFont, FontSource } from "../shared/contract";
import { SYSTEM_FONT } from "../shared/fonts";
import type { Store } from "./store";
import { sourceOf, sourceTag, type CatalogEntry, type RemoteSource } from "./fonts-common";
import { google, googleCss } from "./fonts-google";
import { fontsource } from "./fonts-fontsource";
import { fontshare } from "./fonts-fontshare";
import { addUploadedFace } from "./fonts-upload";

/** In priority order: a family two sources share installs from the first (Google's files are the reference). */
const REMOTES: RemoteSource[] = [google, fontsource, fontshare];
const UPLOAD_TAG = sourceTag("upload").trim();

export function createFonts(store: Store, log: BbPluginApi["log"]) {
  const installedRows = store.db.prepare<[], { key: string; bytes: number; head: string }>(
    "SELECT key, length(value) AS bytes, substr(value, 1, 40) AS head FROM frame_kv WHERE key LIKE 'font:%' ORDER BY key",
  );
  const uploadRows = store.db.prepare<[number, string], { key: string }>(
    "SELECT key FROM frame_kv WHERE key LIKE 'font:%' AND substr(value, 1, ?) = ? ORDER BY key",
  );
  /** font_faces runs on every app sync; memoise the joined CSS per set of families. */
  let facesCache: { key: string; css: string } | null = null;

  const uploadedFamilies = () => uploadRows.all(UPLOAD_TAG.length, UPLOAD_TAG).map((r: { key: string }) => r.key.slice("font:".length));

  /** Every source's list, merged and de-duplicated by name. A source that fails is skipped (and logged). */
  async function entries(): Promise<CatalogEntry[]> {
    const results = await Promise.allSettled(REMOTES.map((r) => r.list()));
    const seen = new Set<string>();
    const merged: CatalogEntry[] = [];
    const add = (e: CatalogEntry) => {
      const k = e.family.toLowerCase();
      if (!seen.has(k)) { seen.add(k); merged.push(e); }
    };
    // Your uploads first: they're few, and they win over a catalogue family of the same name.
    uploadedFamilies().forEach((family: string) => add({ family, category: "Your font", source: "upload" }));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") r.value.forEach(add);
      else log.warn(`calternal-ui: ${REMOTES[i]!.source} catalogue: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`);
    });
    if (results.every((r) => r.status === "rejected")) throw new Error("Could not load any font catalogue.");
    return merged;
  }

  async function catalogue(): Promise<CatalogFont[]> {
    return (await entries()).map(({ family, category, source, ref }) => ({ family, category, source, ...(ref ? { ref } : {}) }));
  }

  /** Downloads a family once from the source that has it; later calls are a single key lookup. */
  async function install(family: string): Promise<void> {
    const key = `font:${family}`;
    if (family === SYSTEM_FONT || store.get(key)) return;
    let entry: CatalogEntry | undefined;
    try {
      entry = (await entries()).find((e) => e.family === family);
    } catch {
      // Every catalogue is unreachable: try Google by name, as before 2026-11-16.
    }
    if (entry?.source === "upload") return;
    const remote = REMOTES.find((r) => r.source === entry?.source);
    const css = remote && entry ? await remote.css(entry) : await googleCss(family);
    store.set(key, sourceTag(entry?.source ?? "google") + css);
  }

  /** Stores one uploaded font file under a family name; returns the name. */
  function upload(family: string, fileName: string, dataUrl: string): string {
    if (family.toLowerCase() === SYSTEM_FONT.toLowerCase()) throw new Error(`"${SYSTEM_FONT}" is the device's own font; pick another name.`);
    const key = `font:${family}`;
    store.set(key, addUploadedFace(store.get(key), family, fileName, dataUrl));
    facesCache = null;
    return family;
  }

  /** @font-face CSS for the enabled overrides; installs anything missing on the way. */
  async function faces(): Promise<string> {
    const prefs = store.prefs();
    // The font overrides in use, plus the wordmark's font while it shows.
    const used = Object.values(prefs.fonts).filter((f) => f.on && f.family).map((f) => f.family);
    if (prefs.brand.text.trim() && prefs.brand.font) used.push(prefs.brand.font);
    const families = [...new Set(used)].filter((f) => f !== SYSTEM_FONT).sort();
    const key = families.join("|");
    if (facesCache?.key === key) return facesCache.css;
    const parts: string[] = [];
    for (const family of families) {
      try {
        await install(family);
        parts.push(store.get(`font:${family}`) ?? "");
      } catch (error) {
        log.warn(`calternal-ui: font ${family}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const css = parts.join("\n");
    facesCache = { key, css };
    return css;
  }

  /** Installed families with their source and stored size (inlined fonts are base64: ~3/4 of the text). */
  function installed(): { family: string; source: FontSource; bytes: number }[] {
    return installedRows.all().map((r: { key: string; bytes: number; head: string }) => ({ family: r.key.slice("font:".length), source: sourceOf(r.head), bytes: Math.round(r.bytes * 0.75) }));
  }

  /** Deletes a family's files. Choosing it again downloads it again (an upload has to be uploaded again). */
  function remove(family: string) {
    store.remove(`font:${family}`);
    facesCache = null;
  }

  return { catalogue, install, upload, faces, installed, remove };
}

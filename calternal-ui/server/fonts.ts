/**
 * Google Fonts: the catalogue for the picker, and local installs. A chosen family is
 * downloaded once (woff2, Latin + Latin Extended, weights 400–700), its files inlined as
 * data URLs into @font-face CSS and stored; bb then serves fonts with no Google requests.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GoogleFont } from "../shared/contract";
import type { Store } from "./store";

/** woff2 needs a modern browser UA; Google serves older formats otherwise. */
const FONT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";
/** Enough for English and most European text, without the weight of CJK subsets. */
const KEEP_SUBSETS = new Set(["latin", "latin-ext"]);
const GSTATIC_URL = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g;
const DAY = 24 * 3600_000;

export function createFonts(store: Store, log: BbPluginApi["log"]) {
  const installedRows = store.db.prepare<[], { key: string; bytes: number }>(
    "SELECT key, length(value) AS bytes FROM frame_kv WHERE key LIKE 'font:%' ORDER BY key",
  );
  let catalogueCache: { at: number; fonts: GoogleFont[] } | null = null;
  /** font_faces runs on every app sync; memoise the joined CSS per set of families. */
  let facesCache: { key: string; css: string } | null = null;

  async function catalogue(): Promise<GoogleFont[]> {
    if (catalogueCache && Date.now() - catalogueCache.at < DAY) return catalogueCache.fonts;
    // Google Fonts' own catalogue; no API key. It starts with an XSSI guard line.
    const response = await fetch("https://fonts.google.com/metadata/fonts", { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Google Fonts returned HTTP ${response.status}.`);
    const text = (await response.text()).replace(/^\)\]\}'\s*/, "");
    const list = (JSON.parse(text) as { familyMetadataList: { family: string; category: string; popularity?: number }[] })
      .familyMetadataList;
    const fonts = [...list]
      .sort((a, b) => (a.popularity ?? 1e9) - (b.popularity ?? 1e9))
      .map((f) => ({ family: f.family, category: f.category }));
    catalogueCache = { at: Date.now(), fonts };
    return fonts;
  }

  async function fetchCss(name: string, axes: string): Promise<Response> {
    return fetch(`https://fonts.googleapis.com/css2?family=${name}${axes}&display=swap`, {
      headers: { "user-agent": FONT_UA }, signal: AbortSignal.timeout(15_000),
    });
  }

  /** Downloads a family once; later calls are a single key lookup. */
  async function install(family: string): Promise<void> {
    const key = `font:${family}`;
    if (store.get(key)) return;
    const name = encodeURIComponent(family).replace(/%20/g, "+");
    let response = await fetchCss(name, ":wght@400;500;600;700");
    // Static families without all four weights refuse the range; take what they have.
    if (response.status === 400) response = await fetchCss(name, "");
    if (!response.ok) throw new Error(`Google Fonts has no family named "${family}".`);
    const css = await response.text();
    // Blocks look like: /* latin */ @font-face { ... src: url(https://fonts.gstatic.com/…) … }
    const blocks = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?(@font-face\s*\{[^}]*\})/g)];
    const labelled = blocks.some((b) => b[1]);
    const kept = blocks.filter((b) => !labelled || KEEP_SUBSETS.has(b[1] ?? "")).map((b) => b[2]);
    const urls = [...new Set(kept.flatMap((b) => [...b.matchAll(GSTATIC_URL)].map((m) => m[1])))];
    const files = new Map(await Promise.all(urls.map(async (url) => {
      const file = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!file.ok) throw new Error(`Downloading ${family} failed (HTTP ${file.status}).`);
      return [url, `data:font/woff2;base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`] as const;
    })));
    const local = kept.map((b) => b.replace(GSTATIC_URL, (_, url: string) => `url(${files.get(url)})`)).join("\n");
    if (!local) throw new Error(`Google Fonts returned no usable files for "${family}".`);
    store.set(key, local);
  }

  /** @font-face CSS for the enabled overrides; installs anything missing on the way. */
  async function faces(): Promise<string> {
    const families = [...new Set(Object.values(store.prefs().fonts).filter((f) => f.on && f.family).map((f) => f.family))].sort();
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

  /** Installed families with their stored size (inlined woff2 is base64: ~3/4 of the text). */
  function installed(): { family: string; bytes: number }[] {
    return installedRows.all().map((r: { key: string; bytes: number }) => ({ family: r.key.slice("font:".length), bytes: Math.round(r.bytes * 0.75) }));
  }

  /** Deletes a family's files. Choosing it again downloads it again. */
  function remove(family: string) {
    store.remove(`font:${family}`);
    facesCache = null;
  }

  return { catalogue, install, faces, installed, remove };
}

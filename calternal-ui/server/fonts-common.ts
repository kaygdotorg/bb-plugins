/**
 * Shared plumbing for the font sources (server/fonts-*.ts): the internal catalogue entry,
 * timed fetches, a day-long cache that keeps the last good list when a source is down, and
 * turning font files into data: URLs so stored @font-face CSS needs no network at all.
 */
import type { FontSource } from "../shared/contract";

/** A picker entry plus what its source needs to install it (an id, slug or weights). */
export type CatalogEntry = {
  family: string;
  category: string;
  source: FontSource;
  /** Fontsource id or Fontshare slug; unused for Google (it goes by family). */
  ref?: string;
  /** Upright weights the source has, when it lists them (Fontshare). */
  weights?: number[];
};

/** One remote catalogue: its list (cached by the module) and an installer that returns @font-face CSS. */
export type RemoteSource = {
  source: FontSource;
  list(): Promise<CatalogEntry[]>;
  /** @font-face CSS with every file inlined; throws when the source has nothing usable. */
  css(entry: CatalogEntry): Promise<string>;
};

export const DAY = 24 * 3600_000;
/** woff2 needs a modern browser UA; Google serves older formats otherwise. */
export const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

/** fetch with a timeout and a readable error naming the source. */
export async function fetchOk(url: string, what: string, timeoutMs = 15_000, headers?: Record<string, string>): Promise<Response> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${what} returned HTTP ${response.status}.`);
  return response;
}

/** Downloads a woff2 file and returns it as a data: URL (base64), ready to inline into CSS. */
export async function woff2DataUrl(url: string, family: string): Promise<string> {
  const file = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!file.ok) throw new Error(`Downloading ${family} failed (HTTP ${file.status}).`);
  return `data:font/woff2;base64,${Buffer.from(await file.arrayBuffer()).toString("base64")}`;
}

/**
 * A list cached for a day. A failed refresh keeps serving the last good list (a source
 * being down shouldn't empty the picker); with nothing cached the error propagates.
 */
export function cachedList(load: () => Promise<CatalogEntry[]>): () => Promise<CatalogEntry[]> {
  let cache: { at: number; list: CatalogEntry[] } | null = null;
  let pending: Promise<CatalogEntry[]> | null = null;
  return async () => {
    if (cache && Date.now() - cache.at < DAY) return cache.list;
    pending ??= load()
      .then((list) => { cache = { at: Date.now(), list }; return list; })
      .catch((error: unknown) => { if (cache) return cache.list; throw error; })
      .finally(() => { pending = null; });
    return pending;
  };
}

/** The four weights bb uses (400–700) that a family has; else the one closest to 400. */
export function pickWeights(available: number[]): number[] {
  const inRange = available.filter((w) => w >= 400 && w <= 700);
  if (inRange.length) return [...new Set(inRange)].sort((a, b) => a - b);
  const closest = [...available].sort((a, b) => Math.abs(a - 400) - Math.abs(b - 400))[0];
  return closest === undefined ? [] : [closest];
}

/** Categories in Google's wording ("Sans Serif", "Monospace"), so every source reads alike. */
export function normalizeCategory(raw: string): string {
  const first = raw.split(",")[0]?.trim().toLowerCase() ?? "";
  const map: Record<string, string> = {
    "sans-serif": "Sans Serif", sans: "Sans Serif", "sans serif": "Sans Serif",
    monospace: "Monospace", mono: "Monospace", serif: "Serif", slab: "Serif",
    display: "Display", handwriting: "Handwriting", handwritten: "Handwriting", script: "Handwriting",
  };
  return map[first] ?? (first ? first[0]!.toUpperCase() + first.slice(1) : "Other");
}

/** The tag stored at the top of each installed family's CSS, so Storage can say where it came from. */
export const sourceTag = (source: FontSource) => `/* cf-source:${source} */\n`;
export function sourceOf(head: string): FontSource {
  const m = /^\/\* cf-source:(\w+) \*\//.exec(head);
  // Fonts installed before 2026-11-16 carry no tag: they all came from Google.
  return (m?.[1] as FontSource | undefined) ?? "google";
}

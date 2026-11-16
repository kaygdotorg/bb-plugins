/**
 * Google Fonts: the catalogue (fonts.google.com/metadata/fonts, no API key, by popularity)
 * and installs through the css2 API: woff2, Latin + Latin Extended, weights 400–700.
 */
import { BROWSER_UA, cachedList, fetchOk, normalizeCategory, woff2DataUrl, type RemoteSource } from "./fonts-common";

/** Enough for English and most European text, without the weight of CJK subsets. */
const KEEP_SUBSETS = new Set(["latin", "latin-ext"]);
const GSTATIC_URL = /url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)/g;

function fetchCss(name: string, axes: string): Promise<Response> {
  return fetch(`https://fonts.googleapis.com/css2?family=${name}${axes}&display=swap`, {
    headers: { "user-agent": BROWSER_UA }, signal: AbortSignal.timeout(15_000),
  });
}

/** css2 for a family name, with its files inlined. Also the fallback when no catalogue answers. */
export async function googleCss(family: string): Promise<string> {
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  let response = await fetchCss(name, ":wght@400;500;600;700");
  // Static families without all four weights refuse the range; take what they have.
  if (response.status === 400) response = await fetchCss(name, "");
  if (!response.ok) throw new Error(`Google Fonts has no family named "${family}".`);
  const css = await response.text();
  // Blocks look like: /* latin */ @font-face { ... src: url(https://fonts.gstatic.com/…) … }
  const blocks = [...css.matchAll(/(?:\/\*\s*([\w-]+)\s*\*\/\s*)?(@font-face\s*\{[^}]*\})/g)];
  const labelled = blocks.some((b) => b[1]);
  const kept = blocks.filter((b) => !labelled || KEEP_SUBSETS.has(b[1] ?? "")).map((b) => b[2]!);
  const urls = [...new Set(kept.flatMap((b) => [...b.matchAll(GSTATIC_URL)].map((m) => m[1]!)))];
  const files = new Map(await Promise.all(urls.map(async (url) => [url, await woff2DataUrl(url, family)] as const)));
  const local = kept.map((b) => b.replace(GSTATIC_URL, (_, url: string) => `url(${files.get(url)})`)).join("\n");
  if (!local) throw new Error(`Google Fonts returned no usable files for "${family}".`);
  return local;
}

export const google: RemoteSource = {
  source: "google",
  list: cachedList(async () => {
    const response = await fetchOk("https://fonts.google.com/metadata/fonts", "Google Fonts");
    // It starts with an XSSI guard line.
    const text = (await response.text()).replace(/^\)\]\}'\s*/, "");
    const list = (JSON.parse(text) as { familyMetadataList: { family: string; category: string; popularity?: number }[] })
      .familyMetadataList;
    return [...list]
      .sort((a, b) => (a.popularity ?? 1e9) - (b.popularity ?? 1e9))
      .map((f) => ({ family: f.family, category: normalizeCategory(f.category), source: "google" as const }));
  }),
  css: (entry) => googleCss(entry.family),
};

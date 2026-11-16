/**
 * Fontsource (fontsource.org, added 2026-11-16): open-source fonts packaged for self-hosting.
 * Its API lists ~2100 families; ~1980 are Google's (installed through Google instead) and
 * the "other" type adds ~120 that Google doesn't carry: Maple Mono, Geist Sans, Monaspace,
 * Commit Mono, Iosevka, iA Writer, Open Runde, Pretendard, Uncut Sans, Mononoki, Comic Mono…
 * All are open licences (mostly OFL); files come from jsDelivr, so self-hosting is the point.
 *
 *   list:   GET https://api.fontsource.org/v1/fonts           → [{ id, family, category, type, … }]
 *   family: GET https://api.fontsource.org/v1/fonts/<id>      → variants[weight][style][subset].url.woff2
 */
import { z } from "zod";
import { cachedList, fetchOk, normalizeCategory, pickWeights, woff2DataUrl, type RemoteSource } from "./fonts-common";

const API = "https://api.fontsource.org/v1/fonts";

const listSchema = z.array(z.object({ id: z.string(), family: z.string(), category: z.string(), type: z.string() }).passthrough());
const familySchema = z.object({
  family: z.string(),
  defSubset: z.string(),
  unicodeRange: z.record(z.string(), z.string()).optional(),
  variants: z.record(z.string(), z.record(z.string(), z.record(z.string(), z.object({ url: z.object({ woff2: z.string().url() }).passthrough() })))),
});

/** Latin + Latin Extended when the API gives their unicode-range; otherwise only one subset, since two
 *  faces of the same weight without a range would hide each other. */
function pickSubsets(available: string[], defSubset: string, ranges: Record<string, string>): string[] {
  const wanted = ["latin", "latin-ext"].filter((s) => available.includes(s));
  if (wanted.length > 1 && wanted.every((s) => ranges[s])) return wanted;
  const one = wanted[0] ?? (available.includes(defSubset) ? defSubset : available[0]);
  return one ? [one] : [];
}

export const fontsource: RemoteSource = {
  source: "fontsource",
  list: cachedList(async () => {
    const response = await fetchOk(API, "Fontsource");
    return listSchema.parse(await response.json())
      .filter((f) => f.type !== "google" && f.type !== "icons")
      .map((f) => ({ family: f.family, category: normalizeCategory(f.category), source: "fontsource" as const, ref: f.id }));
  }),
  async css(entry) {
    if (!entry.ref || !/^[\w-]{1,80}$/.test(entry.ref)) throw new Error(`Fontsource has no id for "${entry.family}".`);
    const data = familySchema.parse(await (await fetchOk(`${API}/${entry.ref}`, "Fontsource")).json());
    const ranges = data.unicodeRange ?? {};
    const faces: { weight: number; subset: string; url: string }[] = [];
    for (const weight of pickWeights(Object.keys(data.variants).map(Number).filter(Number.isFinite))) {
      // Upright only, like the Google installs; a family with no upright face uses its italic.
      const styles = data.variants[String(weight)] ?? {};
      const style = styles.normal ?? Object.values(styles)[0];
      if (!style) continue;
      for (const subset of pickSubsets(Object.keys(style), data.defSubset, ranges)) {
        faces.push({ weight, subset, url: style[subset]!.url.woff2 });
      }
    }
    if (!faces.length) throw new Error(`Fontsource has no usable files for "${entry.family}".`);
    const name = entry.family.replace(/["\\]/g, "");
    const blocks = await Promise.all(faces.map(async (f) => {
      const range = faces.some((o) => o.weight === f.weight && o.subset !== f.subset) && ranges[f.subset] ? `unicode-range: ${ranges[f.subset]};` : "";
      return `/* ${f.subset} */ @font-face { font-family: "${name}"; font-style: normal; font-weight: ${f.weight}; font-display: swap; src: url(${await woff2DataUrl(f.url, entry.family)}) format("woff2"); ${range} }`;
    }));
    return blocks.join("\n");
  },
};

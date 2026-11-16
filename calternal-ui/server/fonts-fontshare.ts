/**
 * Fontshare (fontshare.com, Indian Type Foundry; added 2026-11-16): 100 free families,
 * ~65 of them not on Google (General Sans, Satoshi, Switzer, Cabinet Grotesk, Clash Display,
 * Sentient, Supreme…). Families Google also has are installed through Google instead.
 *
 * Licence: each family is ITF's Free Font License (FFL) or the SIL OFL. The FFL (read
 * 2026-11-16 from the licence file in Fontshare's download zip) allows personal and
 * commercial use and says "You may self-host the Font Software on your own servers or
 * infrastructure for use on your own websites and applications, including through … CSS
 * @font-face". It forbids redistributing the files or serving them to third parties. Each
 * bb server here downloads its own copy for its owner's use, which is that self-hosting.
 *
 *   list: GET https://api.fontshare.com/v2/fonts                         → { fonts: [{ name, slug, category, styles }] }
 *   css:  GET https://api.fontshare.com/v2/css?f[]=<slug>@400,500,700    → @font-face blocks, woff2 at //cdn.fontshare.com/…
 */
import { z } from "zod";
import { cachedList, fetchOk, normalizeCategory, pickWeights, woff2DataUrl, type RemoteSource } from "./fonts-common";

const listSchema = z.object({
  fonts: z.array(z.object({
    name: z.string(),
    slug: z.string(),
    category: z.string(),
    styles: z.array(z.object({ is_italic: z.boolean().optional(), weight: z.object({ weight: z.number() }) }).passthrough()),
  }).passthrough()),
});

const BLOCK = /@font-face\s*\{[^}]*\}/g;
const WOFF2 = /url\('?((?:https:)?\/\/cdn\.fontshare\.com\/[^')]+\.woff2)'?\)/;

export const fontshare: RemoteSource = {
  source: "fontshare",
  list: cachedList(async () => {
    // 100 families today in one page; the limit leaves room to grow.
    const response = await fetchOk("https://api.fontshare.com/v2/fonts?limit=400", "Fontshare");
    return listSchema.parse(await response.json()).fonts.map((f) => ({
      family: f.name,
      category: normalizeCategory(f.category),
      source: "fontshare" as const,
      ref: f.slug,
      // Upright weights only; variable "weights" (1, 2) are not real weights.
      weights: f.styles.filter((s) => !s.is_italic && s.weight.weight >= 100).map((s) => s.weight.weight),
    }));
  }),
  async css(entry) {
    if (!entry.ref || !/^[\w-]{1,80}$/.test(entry.ref)) throw new Error(`Fontshare has no slug for "${entry.family}".`);
    const weights = pickWeights(entry.weights ?? [400, 500, 600, 700]);
    const css = await (await fetchOk(`https://api.fontshare.com/v2/css?f[]=${entry.ref}@${weights.join(",")}&display=swap`, "Fontshare")).text();
    const blocks = await Promise.all([...css.matchAll(BLOCK)].map(async ([block]) => {
      const url = WOFF2.exec(block)?.[1];
      if (!url) return "";
      const data = await woff2DataUrl(url.startsWith("//") ? `https:${url}` : url, entry.family);
      // Keep the block's descriptors; replace its src list (woff2, woff, ttf) with the one inlined woff2.
      // The family name is set to the catalogue's, which is what prefs and bb's CSS ask for.
      return block
        .replace(/src:[^;]*;/, `src: url(${data}) format("woff2");`)
        .replace(/font-family:[^;]*;/, `font-family: "${entry.family.replace(/["\\]/g, "")}";`);
    }));
    const local = blocks.filter(Boolean).join("\n");
    if (!local) throw new Error(`Fontshare returned no usable files for "${entry.family}".`);
    return local;
  },
};

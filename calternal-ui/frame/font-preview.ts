/**
 * Settings previews only: loads a family straight from its source so the picker can show a
 * sample before you choose it. Fonts in use come from the local copy (font_faces) instead.
 * Google: its css2 stylesheet. Fontsource (2026-11-16): the 400 Latin woff2 from jsDelivr.
 * Fontshare: its css API. System and uploads need nothing (the device has one; the server the other).
 */
import type { CatalogFont } from "../shared/contract";

const elementId = (family: string) => `cf-font-${family.replace(/[^\w]/g, "-")}`;

function addStylesheet(id: string, href: string, fallback?: string) {
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.dataset.bbPlugin = "calternal-ui";
  link.href = href;
  if (fallback) link.onerror = () => { link.onerror = null; link.href = fallback; };
  document.head.appendChild(link);
}

export function loadGoogleFontPreview(family: string) {
  const id = elementId(family);
  if (document.getElementById(id)) return;
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  // Static families without all four weights refuse the range: fall back to the default.
  addStylesheet(id, `https://fonts.googleapis.com/css2?family=${name}:wght@400;500;600;700&display=swap`,
    `https://fonts.googleapis.com/css2?family=${name}&display=swap`);
}

/** Fontsource has no stylesheet endpoint; a FontFace for the regular weight is enough for a sample. */
const fontsourceLoaded = new Set<string>();
function loadFontsourcePreview(family: string, id: string) {
  if (fontsourceLoaded.has(id)) return;
  fontsourceLoaded.add(id);
  const face = new FontFace(family, `url(https://cdn.jsdelivr.net/fontsource/fonts/${id}@latest/latin-400-normal.woff2) format("woff2")`);
  document.fonts.add(face);
  face.load().catch(() => { /* no Latin 400 file: the sample keeps its fallback */ });
}

/** Loads a preview for any catalogue entry; a bare family name is taken as Google's. */
export function loadFontPreview(font: CatalogFont | undefined, family: string) {
  if (!font || font.source === "google") return loadGoogleFontPreview(family);
  if (!font.ref || !/^[\w-]+$/.test(font.ref)) return;
  if (font.source === "fontsource") return loadFontsourcePreview(font.family, font.ref);
  if (font.source === "fontshare") {
    const id = elementId(font.family);
    if (!document.getElementById(id)) addStylesheet(id, `https://api.fontshare.com/v2/css?f[]=${font.ref}@400&display=swap`);
  }
}

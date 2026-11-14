/** The wallpaper behind everything: a CSS variable on <html>, cached for instant reloads. */
import { CACHE, cache } from "./events";
import { sampleWallpaper } from "./color";

const root = () => document.documentElement.style;

function cssUrl(src: string): string {
  return `url("${src.replace(/["\\\n]/g, (c) => `\\${c === "\n" ? "a " : c}`)}")`;
}

function setTone(tone: string | null) {
  if (tone) root().setProperty("--cf-wall-tone", tone);
  else root().removeProperty("--cf-wall-tone");
}

/** Shows a wallpaper (or none); its average colour is sampled for the sidebar tint. */
export function applyWallpaper(src: string | null) {
  if (src) root().setProperty("--cf-wall", cssUrl(src));
  else root().removeProperty("--cf-wall");
  cache.set(CACHE.wallpaper, src);
  if (!src) { setTone(null); cache.set(CACHE.tone, null); return; }
  void sampleWallpaper(src).then((colours) => {
    setTone(colours?.tone ?? null);
    cache.set(CACHE.tone, colours?.tone ?? null);
  });
}

export function applyCachedWallpaper() {
  const src = cache.get(CACHE.wallpaper);
  if (src) root().setProperty("--cf-wall", cssUrl(src));
  setTone(cache.get(CACHE.tone));
}

export function clearWallpaper() {
  root().removeProperty("--cf-wall");
  root().removeProperty("--cf-wall-tone");
}

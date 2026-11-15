/**
 * Storage: one view over everything this plugin keeps on the bb server (wallpapers in the
 * library, installed Google Fonts), and removal that really frees the space (VACUUM).
 */
import type { Assets, FontPrefs } from "../shared/contract";
import type { Store } from "./store";
import type { createFonts } from "./fonts";
import type { createWallpapers } from "./wallpapers";

const FONT_SURFACES: Record<keyof FontPrefs, string> = { ui: "UI", chat: "Chat", code: "Code", terminal: "Terminal" };

export function createAssets(
  store: Store,
  wallpapers: ReturnType<typeof createWallpapers>,
  fonts: ReturnType<typeof createFonts>,
) {
  /** Which font overrides use a family (only switched-on ones count). */
  function usedBy(family: string): (keyof FontPrefs)[] {
    const prefs = store.prefs().fonts;
    return (Object.keys(prefs) as (keyof FontPrefs)[]).filter((k) => prefs[k].on && prefs[k].family === family);
  }

  function list(): Assets {
    return {
      wallpapers: wallpapers.sizes(),
      fonts: fonts.installed().map((f) => ({ ...f, usedBy: usedBy(f.family).map((k) => FONT_SURFACES[k]) })),
    };
  }

  function removeFont(family: string) {
    const using = usedBy(family);
    if (using.length > 0) {
      const prefs = store.prefs();
      const next = { ...prefs.fonts };
      for (const k of using) next[k] = { ...next[k], on: false };
      store.savePrefs({ ...prefs, fonts: next });
    }
    fonts.remove(family);
  }

  function remove(kind: "wallpaper" | "font", id: string): Assets {
    if (kind === "wallpaper") wallpapers.remove(id);
    else removeFont(id);
    store.vacuum();
    return list();
  }

  /** Removes everything of a kind that is not in use (the active wallpaper, fonts in use stay). */
  function prune(kind: "wallpaper" | "font"): Assets {
    const current = list();
    if (kind === "wallpaper") current.wallpapers.filter((w) => !w.active).forEach((w) => wallpapers.remove(w.id));
    else current.fonts.filter((f) => f.usedBy.length === 0).forEach((f) => fonts.remove(f.family));
    store.vacuum();
    return list();
  }

  return { list, remove, prune };
}

/** Fired after the settings screen saves, so the overlay re-reads the server and re-applies. */
export const CHANGED_EVENT = "calternal-frame:changed";

/** localStorage keys: the last applied values, so a reload paints right away. */
export const CACHE = {
  wallpaper: "calternal-frame:wallpaper",
  tone: "calternal-frame:tone",
  accent: "calternal-frame:accent",
  prefs: "calternal-frame:prefs",
  faces: "calternal-frame:font-faces",
} as const;

/** localStorage that never throws (quota, privacy mode): caching is only an optimisation. */
export const cache = {
  get: (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } },
  set: (key: string, value: string | null) => {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* skip */ }
  },
};

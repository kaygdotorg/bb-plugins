/**
 * Opinionated defaults. Plain data with no zod, so the settings screen can import it for
 * its Reset buttons without pulling the server's schemas into the frontend bundle.
 */
import type { FramePrefs } from "./contract";

export const DEFAULT_PREFS: FramePrefs = {
  wallpaperUrl: "",
  wallpaperCredit: null,
  // A bright wallpaper around a deeper chat card: the contrast is what makes the card float.
  sidebar: { blur: { on: true, value: 12 }, tint: { on: true, value: 35 }, dim: { on: false, value: 20 } },
  chat: { blur: { on: true, value: 75 }, tint: { on: true, value: 85 }, dim: { on: true, value: 30 } },
  fonts: {
    ui: { on: false, family: "Inter" },
    chat: { on: false, family: "Source Serif 4" },
    code: { on: false, family: "JetBrains Mono" },
    terminal: { on: false, family: "JetBrains Mono" },
  },
  // 100% here is bb's 110%: see frame/css.ts.
  uiScale: 100,
  clock: "24h",
  chatWidth: "wide",
  brand: { text: "bb", font: "Dancing Script" },
  accent: { mode: "wallpaper", color: "#d9925b" },
};

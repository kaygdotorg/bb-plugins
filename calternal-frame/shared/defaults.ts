/**
 * Opinionated defaults. Plain data with no zod, so the settings screen can import it for
 * its Reset buttons without pulling the server's schemas into the frontend bundle.
 */
import type { FramePrefs } from "./contract";

export const DEFAULT_PREFS: FramePrefs = {
  wallpaperUrl: "",
  wallpaperCredit: null,
  // A visible wallpaper around a calm, tinted chat card.
  sidebar: { blur: { on: true, value: 12 }, tint: { on: true, value: 50 }, dim: { on: false, value: 20 } },
  chat: { blur: { on: true, value: 75 }, tint: { on: true, value: 75 }, dim: { on: true, value: 25 } },
  fonts: {
    ui: { on: false, family: "Inter" },
    chat: { on: false, family: "Source Serif 4" },
    code: { on: false, family: "JetBrains Mono" },
    terminal: { on: false, family: "JetBrains Mono" },
  },
  // 100% here is bb's 110%: see frame/css.ts.
  uiScale: 100,
  accent: { mode: "wallpaper", color: "#d9925b" },
  usage: { enabled: true, showPercent: true, showIcons: false, window: "auto" },
};

/**
 * The accent: one hue that bb's otherwise grey palette follows (see the accent section of
 * css.ts). Only hue and chroma are set here; css.ts fixes lightness per scheme so any
 * hue stays legible.
 */
import type { FramePrefs } from "../shared/contract";
import { CACHE, cache } from "./events";
import { hexToRgb, sampleWallpaper, toOklch } from "./color";

/** Calternal amber, for wallpapers with no colour to give. */
const FALLBACK = { c: 0.12, h: 62 };

function setAccent(c: number, h: number) {
  const root = document.documentElement.style;
  // Chroma is lifted to read as colour and capped so it never turns neon.
  root.setProperty("--cf-accent-c", Math.min(0.17, Math.max(0.09, c * 1.4)).toFixed(3));
  root.setProperty("--cf-accent-h", h.toFixed(1));
  cache.set(CACHE.accent, JSON.stringify({ c, h }));
}

/** The wallpaper's hue, or a custom colour's hue and chroma. */
export async function applyAccent(accent: FramePrefs["accent"], wallpaper: string | null) {
  if (accent.mode === "custom") {
    const rgb = hexToRgb(accent.color);
    if (rgb) { const { c, h } = toOklch(...rgb); setAccent(c, h); return; }
  }
  const hue = wallpaper ? (await sampleWallpaper(wallpaper))?.hue : null;
  setAccent((hue ?? FALLBACK).c, (hue ?? FALLBACK).h);
}

export function applyCachedAccent() {
  const cached = cache.get(CACHE.accent);
  if (!cached) return;
  try { const { c, h } = JSON.parse(cached) as { c: number; h: number }; setAccent(c, h); } catch { /* ignore */ }
}

export function clearAccent() {
  document.documentElement.style.removeProperty("--cf-accent-c");
  document.documentElement.style.removeProperty("--cf-accent-h");
}

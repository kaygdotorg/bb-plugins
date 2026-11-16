/**
 * Settings → CSS: surface effects and interface size become variables on <html>; font
 * overrides become a small stylesheet; locally stored @font-face rules are injected as-is.
 * All of it is cached so a reload paints with the right look before the server answers.
 */
import type { FramePrefs } from "../shared/contract";
import { CACHE, cache } from "./events";
import { R } from "./selectors";
import { preblurBlurs } from "./preblur";
import { setClock } from "./clock";
import { SYSTEM_FONT, systemStack } from "../shared/fonts";

type Surface = FramePrefs["sidebar"];
export type AppliedPrefs = Pick<FramePrefs, "sidebar" | "chat" | "fonts" | "uiScale"> & Partial<Pick<FramePrefs, "clock" | "chatWidth">>;

const root = () => document.documentElement.style;

function surfaceVars(prefix: "side" | "card", base: "--cf-side" | "--cf-bg", s: Surface): Record<string, string> {
  const saturate = prefix === "side" ? 120 : 140;
  return {
    [`--cf-${prefix}-blur`]: s.blur.on && s.blur.value > 0 ? `blur(${s.blur.value}px) saturate(${saturate}%)` : "none",
    [`--cf-${prefix}-tint`]: s.tint.on ? `color-mix(in oklab, var(${base}) ${s.tint.value}%, transparent)` : "transparent",
    // Only the strength: css.ts picks the colour per theme (black in dark, white in light).
    [`--cf-${prefix}-dim-a`]: s.dim.on ? String(Math.min(100, s.dim.value) / 100) : "0",
  };
}

const quote = (family: string) => `"${family.replace(/["\\]/g, "")}"`;
/** A family for CSS; "System" becomes the device's font stack (SF Pro / SF Mono on Apple devices). */
const face = (family: string, mono: boolean) => (family === SYSTEM_FONT ? systemStack(mono) : quote(family));

/** One rule per enabled override; bb reads fonts from --font-sans / --font-mono / --font-terminal. */
function fontCss(fonts: FramePrefs["fonts"]): string {
  const rules: string[] = [];
  if (fonts.ui.on && fonts.ui.family) {
    rules.push(`${R} { --font-sans: ${face(fonts.ui.family, false)}, "Inter Variable", Inter, sans-serif; }`);
  }
  if (fonts.chat.on && fonts.chat.family) {
    // Chat and its composer: the variable (font-sans utilities) and the inherited family.
    rules.push(`${R} [data-thread-window], ${R} [data-app-composer] { --font-sans: ${face(fonts.chat.family, false)}, "Inter Variable", Inter, sans-serif; font-family: var(--font-sans); }`);
  }
  if (fonts.code.on && fonts.code.family) {
    rules.push(`${R} { --font-mono: ${face(fonts.code.family, true)}, ui-monospace, SFMono-Regular, Menlo, monospace; }`);
  }
  if (fonts.terminal.on && fonts.terminal.family) {
    // bb's terminal reads this when it opens; open terminals keep their font until reopened.
    rules.push(`${R} { --font-terminal: ${face(fonts.terminal.family, true)}, "JetBrainsMono Nerd Font Mono", ui-monospace, monospace; }`);
  }
  return rules.join("\n");
}

function styleElement(id: string): HTMLStyleElement {
  let style = document.getElementById(id) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement("style");
    style.id = id;
    style.dataset.bbPlugin = "calternal-ui";
    document.head.appendChild(style);
  }
  return style;
}

/** Writes only when the text changed: restyling the whole app is the expensive part. */
function setText(style: HTMLStyleElement, text: string) {
  if (style.textContent !== text) style.textContent = text;
}

/** Sets the interface size live (the settings slider previews it while dragging). */
export function setUiScale(percent: number) {
  root().setProperty("--cf-ui-scale", String(percent / 100));
}

export function applyPrefs(prefs: AppliedPrefs, save = true) {
  const vars = { ...surfaceVars("side", "--cf-side", prefs.sidebar), ...surfaceVars("card", "--cf-bg", prefs.chat) };
  for (const [name, value] of Object.entries(vars)) root().setProperty(name, value);
  const blurOf = (s: Surface) => (s.blur.on ? s.blur.value : 0);
  preblurBlurs(blurOf(prefs.sidebar), blurOf(prefs.chat));
  setUiScale(prefs.uiScale);
  setClock(prefs.clock ?? "24h");
  // Wide chat (css.ts): the default; "centered" keeps bb's own column.
  document.documentElement.toggleAttribute("data-cf-wide", (prefs.chatWidth ?? "wide") === "wide");
  setText(styleElement("cf-fonts"), fontCss(prefs.fonts));
  if (save) cache.set(CACHE.prefs, JSON.stringify(prefs));
}

/** The locally stored @font-face rules (font files inlined as data URLs). */
export function applyFontFaces(css: string, save = true) {
  setText(styleElement("cf-fontfaces"), css);
  if (save) cache.set(CACHE.faces, css);
}

export function applyCachedPrefs() {
  const faces = cache.get(CACHE.faces);
  if (faces) applyFontFaces(faces, false);
  const prefs = cache.get(CACHE.prefs);
  if (!prefs) return;
  try { applyPrefs(JSON.parse(prefs) as AppliedPrefs, false); } catch { /* stale shape: the server answers soon */ }
}

export function clearPrefs() {
  for (const p of ["side", "card"]) for (const k of ["blur", "tint", "dim-a"]) root().removeProperty(`--cf-${p}-${k}`);
  root().removeProperty("--cf-ui-scale");
  document.documentElement.removeAttribute("data-cf-wide");
  document.getElementById("cf-fonts")?.remove();
  document.getElementById("cf-fontfaces")?.remove();
  document.querySelectorAll('link[data-bb-plugin="calternal-ui"]').forEach((l) => l.remove());
}

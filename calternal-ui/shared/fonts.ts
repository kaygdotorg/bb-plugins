/**
 * Font facts shared by the server, the frame and Settings. Plain data, no zod (the app imports it).
 *
 * The "System" family (added 2026-11-16) is the device's own UI font: SF Pro and SF Mono on
 * Apple devices, Segoe UI / Roboto / Cantarell elsewhere. Apple's licence doesn't allow SF
 * to be downloaded or redistributed, so asking the browser for the system font is the
 * legitimate way to get it on an iPhone or Mac. Nothing is downloaded for it.
 */
import type { FontSource } from "./contract";

/** The family value saved in prefs for the system font. No catalogue has a family by this name. */
export const SYSTEM_FONT = "System";

/** The CSS stack for the system font: text faces for ui/chat, monospaced for code/terminal. */
export const systemStack = (mono: boolean) =>
  mono
    ? `ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace`
    : `-apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", Roboto, sans-serif`;

/** How each source is named in the picker's right column and in Storage. */
export const SOURCE_LABEL: Record<FontSource, string> = {
  google: "Google",
  fontsource: "Fontsource",
  fontshare: "Fontshare",
  upload: "Upload",
  system: "System",
};

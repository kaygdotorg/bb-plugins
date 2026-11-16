/**
 * Uploaded fonts (added 2026-11-16): font files you own, for families no catalogue carries
 * (SF Pro from Apple's developer site for your own devices, Obel Mono, a licensed face).
 * Each file becomes one @font-face in the family's stored CSS; uploading more files under
 * the same family name adds weights and italics. The file's format is read from its first
 * bytes, its weight and style from its file name ("SF-Pro-Text-Semibold.otf" → 600, upright).
 */
import { sourceTag, sourceOf } from "./fonts-common";

/** Longest names first, so "SemiBold" isn't read as "Bold". */
const WEIGHT_WORDS: [RegExp, number][] = [
  [/(extra|ultra)[-_ ]?light/i, 200], [/(extra|ultra)[-_ ]?bold/i, 800], [/(semi|demi)[-_ ]?bold/i, 600],
  [/hairline|thin/i, 100], [/light/i, 300], [/medium/i, 500], [/bold/i, 700], [/black|heavy/i, 900],
];

/** "400", "700" or, for a variable font, the whole "100 900" range. */
export function weightFromName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  if (/variable|[-_ ]vf\b|\[wght/i.test(base)) return "100 900";
  const numeric = /(?:^|[-_ ])([1-9]00)(?:$|[-_ ])/.exec(base);
  if (numeric) return numeric[1]!;
  return String(WEIGHT_WORDS.find(([re]) => re.test(base))?.[1] ?? 400);
}

export const styleFromName = (fileName: string) => (/italic|oblique/i.test(fileName) ? "italic" : "normal");

/** The CSS format() and media type for a font file, from its magic bytes; null if it isn't one we take. */
export function sniffFormat(bytes: Buffer): { format: string; mime: string } | null {
  const magic = bytes.subarray(0, 4).toString("latin1");
  if (magic === "wOF2") return { format: "woff2", mime: "font/woff2" };
  if (magic === "wOFF") return { format: "woff", mime: "font/woff" };
  if (magic === "OTTO") return { format: "opentype", mime: "font/otf" };
  if (magic === "\x00\x01\x00\x00" || magic === "true") return { format: "truetype", mime: "font/ttf" };
  return null; // TrueType collections (ttcf) and anything else: browsers can't use them in @font-face.
}

/**
 * The family's stored CSS after adding one file. A file with the same weight and style
 * replaces the earlier one; a family installed from a catalogue is replaced as a whole.
 */
export function addUploadedFace(existing: string | undefined, family: string, fileName: string, dataUrl: string): string {
  const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bytes = Buffer.from(base64, "base64");
  const kind = sniffFormat(bytes);
  if (!kind) throw new Error("That file isn't a font browsers can use. Upload a .woff2, .woff, .ttf or .otf file.");
  const weight = weightFromName(fileName);
  const style = styleFromName(fileName);
  // Each face is one line, keyed by a leading comment so a re-upload can replace it.
  const key = `/* face:${weight}:${style} */`;
  const kept = existing && sourceOf(existing) === "upload"
    ? existing.split("\n").filter((line) => line.startsWith("/* face:") && !line.startsWith(key))
    : [];
  const name = family.replace(/["\\]/g, "");
  const face = `${key} @font-face { font-family: "${name}"; font-style: ${style}; font-weight: ${weight}; font-display: swap; src: url(data:${kind.mime};base64,${bytes.toString("base64")}) format("${kind.format}"); }`;
  return sourceTag("upload") + [...kept, face].join("\n");
}

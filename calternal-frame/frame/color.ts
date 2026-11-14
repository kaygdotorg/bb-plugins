/** Small colour helpers: sRGB → OKLCH, and reading a wallpaper's colours in one pass. */

export interface Hue { c: number; h: number }

/** sRGB (0–255) → OKLCH chroma and hue (lightness is not needed here). */
export function toOklch(r: number, g: number, b: number): Hue {
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const b2 = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { c: Math.hypot(a, b2), h: ((Math.atan2(b2, a) * 180) / Math.PI + 360) % 360 };
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface WallpaperColours {
  /** Average colour, for tinting the sidebars. */
  tone: string;
  /** The most vivid common hue, for the accent; null for a grey image. */
  hue: Hue | null;
}

const memo = new Map<string, Promise<WallpaperColours | null>>();

/**
 * Decodes the wallpaper once at 48×48 and reads both colours from the same pixels. Hues
 * are binned by OKLCH hue and scored by count × chroma, so a large area of colour wins
 * over a few saturated specks. Memoised per image. Null when unreadable (cross-origin).
 */
export function sampleWallpaper(src: string): Promise<WallpaperColours | null> {
  const key = src.length > 256 ? `${src.length}:${src.slice(-128)}` : src;
  let pending = memo.get(key);
  if (!pending) {
    pending = sample(src);
    memo.clear(); // only the current wallpaper matters
    memo.set(key, pending);
  }
  return pending;
}

async function sample(src: string): Promise<WallpaperColours | null> {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = src;
  try {
    await img.decode();
    const size = 48;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;
    let r = 0, g = 0, b = 0;
    const bins = Array.from({ length: 24 }, () => ({ score: 0, x: 0, y: 0, c: 0, n: 0 }));
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      const { c, h } = toOklch(data[i], data[i + 1], data[i + 2]);
      if (c < 0.03) continue; // greys carry no hue
      const bin = bins[Math.floor(h / 15) % 24];
      bin.score += c;
      bin.x += Math.cos((h * Math.PI) / 180) * c;
      bin.y += Math.sin((h * Math.PI) / 180) * c;
      bin.c += c;
      bin.n += 1;
    }
    const n = data.length / 4;
    const best = bins.reduce((a, z) => (z.score > a.score ? z : a));
    return {
      tone: `rgb(${Math.round(r / n)} ${Math.round(g / n)} ${Math.round(b / n)})`,
      hue: best.n < 20 ? null : { c: best.c / best.n, h: ((Math.atan2(best.y, best.x) * 180) / Math.PI + 360) % 360 },
    };
  } catch {
    return null;
  }
}

/**
 * Adaptive pill glass (kayg, 2026-11-16: "for the pill surfaces, can we dynamically detect contrast perhaps and
 * tint it more for lighter backgrounds?"). The one glass is clear (blur + brightness, no fill, kayg rejected a grey
 * tint), which reads well over the plain card. Where a pill passes over something that fights its glyphs (a photo
 * or a solid block under a light-mode pill, a bright patch of wallpaper under a dark-mode one), this module gives
 * THAT pill a faint fill in the theme's own pill tint (warm white / near-black, `--cf-pill-tint`), just enough to
 * bring its glyphs back to 3:1 (icons) or 4.5:1 (words). Over plain backgrounds every pill stays clear.
 *
 * Output: `--cf-pill-wash` (0..1, steps of 0.1) on each glass pill, written only on change. GLASS_LAYER (pills.ts)
 * turns it into an alpha of wash × `--cf-pill-wash-max` (0.35). It's `wash`, not the brief's `--cf-pill-tint`:
 * that name already holds the tint's RGB.
 *
 * A page can't read the pixels behind an element, so the backdrop is estimated from what we know:
 *   - the surface under the pill (the card, or the window backdrop for the drawer's search button): its layers'
 *     computed colours (`::before`/`::after`) composited over the wallpaper, which is decoded once into a 1/16
 *     viewport grid (same-origin data/blob URL; recomputed on resize, theme, prefs or wallpaper change only);
 *   - "hazards" in the chat that scroll under the pills: images, video, canvases, iframes, and blocks with a solid
 *     background (alpha >= 0.25; bb's 6% recessed tints don't move contrast). Each is classified once (images by
 *     an 8×8 decode where same-origin, else assumed busy: dark AND bright);
 *   - the title fade (css.ts) between the chat and the header pills, ~61% card colour at their centre.
 *
 * What it does in practice (estimates, 2026-11-16): the header pills sit on the title fade, so even a near-black
 * block (light) or a white block (dark) only drops them to ~9 / ~4.8:1 and they stay clear. The pills without a
 * veil get the fill: scroll-to-latest over a dark block in light mode 1.0 → 3.2:1 (wash 1), over a photo 1.4 →
 * 3.1 (0.7); in dark mode over a white block 1.9 → 3.1 (0.8). The 0.35 cap (kayg: no grey tint) can stop short
 * of 4.5 for words on an unveiled pill; today every word-carrying pill is under the fade.
 *
 * Cost (why it's built this way). A per-scroll elementsFromPoint under each pill measured 2.7–3.0ms per frame for
 * 5–6 pills in headless Chrome (1440×900 and 440×956, 2026-11-16), and re-querying the pills 0.9–1.3ms: a third of
 * a 120Hz frame. So nothing runs per scroll frame here. Hazards are watched by an IntersectionObserver whose root
 * margin is the band the pills occupy (± the 16px glass blur); its callback runs only when a hazard enters or
 * leaves that band and does a few rect comparisons (0.1–0.4ms headless). DOM discovery (pills, new hazards) is a
 * throttled rescan in idle time (at most every 500ms while bb streams): ~1ms, ~2ms when it also re-finds the pills
 * (every 2s, and after layout/theme/prefs changes). Headless numbers on a 2,700-element thread; a real machine is
 * several times faster. `?cf-perf` exposes them as window.__cfPillContrast.stats.
 *
 * The browser draws the glass as: backdrop → blur → saturate → brightness(b), then the ::before's own fill on
 * top. The estimate follows that order in gamma-encoded sRGB (CSS filter functions and compositing work there),
 * ignoring blur (it only averages) and saturation (it roughly keeps luminance).
 */
import { perfEnabled } from "./perf-probe";

/** The alpha a wash of 1 adds (must match `--cf-pill-wash-max` in pills.ts). */
const WASH_MAX = 0.35;
/** The glass's blur radius: what it can pull in from around the pill. */
const REACH = 16;
/** Images smaller than this are icons or avatars: too small to matter behind a blurred 36pt pill. */
const MIN_MEDIA = 32;
/** A background below this alpha (bb's 2.5–6.5% ink tints) changes a pill's contrast by a few percent at most. */
const MIN_BG_ALPHA = 0.25;
const RESCAN_MS = 500;

/** Glass pills (each has GLASS_LAYER on its ::before). Only those whose ::before actually has a backdrop filter
 *  in the current layout are used, so desktop-only and phone-only selectors can share the list. `text`: carries
 *  words (4.5:1), else icons (3:1). Each is queried inside its scope (main's <header>, main, or the document):
 *  the same list as one document-wide selector took ~2ms per rescan on a 2,700-element thread (headless). */
type Scope = "header" | "main" | "doc";
const PILLS: { scope: Scope; sel: string; text: boolean }[] = [
  { scope: "header", sel: "div[data-cf-pane-tools]", text: false },
  { scope: "header", sel: '[data-testid="app-page-header-content-row"] > div:first-child > div', text: true }, // desktop title pill
  { scope: "header", sel: "[data-cf-title-wrap]", text: true }, // phone title capsule
  { scope: "header", sel: '[data-testid="app-page-header-content-row"] > div:first-child > div > div.min-w-0', text: true }, // phone, plain pages
  { scope: "header", sel: 'button[aria-label="Thread actions"]', text: false },
  { scope: "main", sel: 'button[aria-label="Scroll to latest event"]', text: false },
  { scope: "main", sel: 'div.fixed.z-40 > button[aria-label^="Show right panel"]', text: false },
  { scope: "doc", sel: '[data-testid="app-sidebar-trigger-overlay"] button', text: false },
  { scope: "doc", sel: "[data-cf-sb-tools]", text: false },
];
const BY_SCOPE = (scope: Scope) => PILLS.filter((p) => p.scope === scope).map((p) => p.sel).join(", ");
const QUERY = { header: BY_SCOPE("header"), main: BY_SCOPE("main") }; // "doc" pills: queryPills()
const TEXT = PILLS.filter((p) => p.text).map((p) => p.sel).join(", ");

/** Live collections: cheap to keep, and a walk only when read after the DOM changed. */
const MAINS = document.getElementsByTagName("main");
const mainEl = () => [...MAINS].find((m) => m.getAttribute("data-sidebar") === "inset") ?? null;

/** Every pill element in the document. Doc-scoped pills sit under a known ancestor found with a first-match
 *  query (a document-wide `[data-testid=…] button` checked every button's ancestors: ~1ms). */
function queryPills(): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const main of MAINS) {
    if (main.getAttribute("data-sidebar") !== "inset") continue;
    for (const h of main.getElementsByTagName("header")) out.push(...h.querySelectorAll<HTMLElement>(QUERY.header));
    out.push(...main.querySelectorAll<HTMLElement>(QUERY.main));
  }
  const toggle = hosts.toggle()?.querySelector<HTMLElement>("button");
  if (toggle) out.push(toggle);
  const search = hosts.sidebar()?.querySelector<HTMLElement>("[data-cf-sb-tools]");
  if (search) out.push(search);
  return out;
}

/** bb's toggle overlay sits late in the document: finding it took 0.5–1.6ms, so it (and the sidebar) are kept
 *  until they leave the DOM. */
const cached = (sel: string) => { let el: Element | null = null; return () => (el?.isConnected ? el : (el = document.querySelector(sel))); };
const hosts = { toggle: cached('[data-testid="app-sidebar-trigger-overlay"]'), sidebar: cached('[data-sidebar="sidebar"]') };

const SCROLLERS = "[data-page-scroll-viewport]"; // inside main
const HAZARDS = 'img, video, canvas, iframe, pre, [class*="bg-"]';

type Rgb = [number, number, number]; // gamma-encoded sRGB, 0..1
interface Rgba { c: Rgb; a: number }
interface Pill { el: HTMLElement; text: boolean; card: boolean; rect: DOMRect; base: Rgb[]; veil: Rgba | null; glyph: Rgb; fill: Rgb; bright: number; wash: string; before: number; after: number }
interface Band { key: string; io: IntersectionObserver; pills: Pill[]; inside: Map<Element, DOMRect> }

/* ── Colour maths ─────────────────────────────────────────────────────────────────────────────── */

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a: Rgb, b: Rgb) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (bottom: Rgb, top: Rgba): Rgb => [0, 1, 2].map((i) => top.c[i] * top.a + bottom[i] * (1 - top.a)) as Rgb;

/** Any CSS colour (oklab, color-mix results, …) → sRGB, through a 1×1 canvas. Memoised. */
let probe: CanvasRenderingContext2D | null = null;
const parsed = new Map<string, Rgba | null>();
function rgba(css: string): Rgba | null {
  let hit = parsed.get(css);
  if (hit !== undefined) return hit;
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  hit = null;
  if (probe) {
    probe.canvas.width = probe.canvas.height = 1;
    probe.fillStyle = "#010203";
    probe.fillStyle = css;
    if (probe.fillStyle !== "#010203" || css.trim() === "#010203") {
      probe.clearRect(0, 0, 1, 1);
      probe.fillRect(0, 0, 1, 1);
      const d = probe.getImageData(0, 0, 1, 1).data;
      hit = { c: [d[0] / 255, d[1] / 255, d[2] / 255], a: d[3] / 255 };
    }
  }
  if (parsed.size > 200) parsed.clear();
  parsed.set(css, hit);
  return hit;
}

/** Splits a computed list at top-level commas (`linear-gradient(a, b), url(…)`). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0, from = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) { out.push(s.slice(from, i).trim()); from = i + 1; }
  }
  out.push(s.slice(from).trim());
  return out;
}

/* ── The wallpaper, as a small luminance grid ─────────────────────────────────────────────────── */

let wall: { key: string; w: number; h: number; vw: number; vh: number; data: Uint8ClampedArray } | null = null;
let wallLoading = "";

/** The wallpaper's URL: preblur.ts's small blurred copy when there is one (a short blob URL), else the image. */
function wallSource(): { key: string; url: string } | null {
  const st = document.documentElement.style;
  const v = st.getPropertyValue("--cf-wall-card") || st.getPropertyValue("--cf-wall");
  // Sliced, not matched with a regex: without preblur (Safari) this is the whole ~1.3MB data URL.
  const t = v.trim();
  if (!t.startsWith("url(") || !t.endsWith(")")) return null;
  let url = t.slice(4, -1).trim();
  if (url.startsWith('"') && url.endsWith('"')) url = url.slice(1, -1);
  if (url.includes("\\")) url = url.replace(/\\(.)/g, "$1"); // wallpaper.ts cssUrl() escapes quotes and backslashes
  return { key: `${url.length}:${url.slice(0, 48)}:${url.slice(-64)}:${innerWidth}x${innerHeight}`, url };
}

/** Decodes the wallpaper once per (image, viewport) into a 1/16-viewport grid, cover-fitted like the CSS. */
function ensureWall(onReady: () => void) {
  const src = wallSource();
  if (!src) { wall = null; return; }
  if (wall?.key === src.key || wallLoading === src.key) return;
  wallLoading = src.key;
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    if (wallLoading !== src.key) return;
    wallLoading = "";
    const vw = innerWidth, vh = innerHeight;
    const w = Math.max(8, Math.round(vw / 16)), h = Math.max(8, Math.round(vh / 16));
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const k = Math.max(w / img.naturalWidth, h / img.naturalHeight);
    const dw = img.naturalWidth * k, dh = img.naturalHeight * k;
    // ~48px of blur at full size: between the side backdrop's 12px and the card's 50–75px, so a pill's
    // estimate sees the same soft patches the glass does.
    if ("filter" in ctx) ctx.filter = "blur(3px)";
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
    try { wall = { key: src.key, w, h, vw, vh, data: ctx.getImageData(0, 0, w, h).data }; } catch { wall = null; }
    onReady();
  };
  img.onerror = () => { if (wallLoading === src.key) wallLoading = ""; };
  img.src = src.url;
}

/** The darkest and brightest wallpaper colours within a viewport rect. */
function wallRange(r: DOMRect): Rgb[] | null {
  if (!wall) return null;
  const sx = wall.w / wall.vw, sy = wall.h / wall.vh;
  const x0 = Math.max(0, Math.floor((r.left - REACH) * sx)), x1 = Math.min(wall.w - 1, Math.ceil((r.right + REACH) * sx));
  const y0 = Math.max(0, Math.floor((r.top - REACH) * sy)), y1 = Math.min(wall.h - 1, Math.ceil((r.bottom + REACH) * sy));
  let lo: Rgb | null = null, hi: Rgb | null = null, lmin = 2, lmax = -1;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * wall.w + x) * 4;
    const c: Rgb = [wall.data[i] / 255, wall.data[i + 1] / 255, wall.data[i + 2] / 255];
    const l = lum(c);
    if (l < lmin) { lmin = l; lo = c; }
    if (l > lmax) { lmax = l; hi = c; }
  }
  return lo && hi ? [lo, hi] : null;
}

/* ── Surfaces: what is under a pill before any chat content ─────────────────────────────────────── */

/** One background layer: a colour, or the wallpaper (`url()`, cover-fitted and opaque). */
type Op = Rgba | "wall";

/** An element's (or pseudo's) background as layers, bottom first: its colour, then its images (gradients as
 *  their first colour). Read once per generation and element: the wallpaper's layer can be the whole ~1.3MB
 *  data URL (before preblur is ready, and always in Safari), so it is skipped over, never scanned. */
let opsGen = -1;
const opsCache = new Map<Element, Map<string, Op[]>>();
function opsOf(el: Element, pseudo: string | null, gen: number): Op[] {
  if (opsGen !== gen) { opsCache.clear(); opsGen = gen; }
  let byPseudo = opsCache.get(el);
  if (!byPseudo) opsCache.set(el, (byPseudo = new Map()));
  const hit = byPseudo.get(pseudo ?? "");
  if (hit) return hit;
  const cs = getComputedStyle(el, pseudo);
  const ops: Op[] = [];
  if (!pseudo || (cs.content !== "none" && cs.display !== "none")) {
    const op = parseFloat(cs.opacity) || 0;
    const add = (c: Rgba | null) => { if (c && c.a > 0) ops.push({ c: c.c, a: c.a * op }); };
    add(rgba(cs.backgroundColor));
    const img = cs.backgroundImage;
    if (img !== "none") {
      const layers: Op[] = [];
      for (let i = 0; i < img.length;) {
        if (img.startsWith("url(", i)) {
          if (op > 0.5) layers.push("wall");
          i = img.indexOf(")", i) + 1 || img.length; // base64 has no ")"
        } else if (img.startsWith("linear-gradient(", i)) {
          const end = img.indexOf("), ", i);
          const inner = img.slice(i + 16, end < 0 ? -1 : end);
          const first = splitTop(inner).map(rgba).find((c) => c);
          if (first && first.a > 0) layers.push({ c: first.c, a: first.a * op });
          i = end < 0 ? img.length : end + 1;
        } else i++;
      }
      ops.push(...layers.reverse());
    }
  }
  byPseudo.set(pseudo ?? "", ops);
  return ops;
}

function paint(cands: Rgb[], ops: Op[], r: DOMRect): Rgb[] {
  for (const o of ops) {
    if (o === "wall") { const w = wallRange(r); if (w) cands = w; }
    else cands = cands.map((b) => over(b, o));
  }
  return cands;
}

/** The surfaces under pills, found once per full rescan: the window backdrop and the card (the phone pane, or on
 *  desktop the first panel / a plain page's shell). */
interface Surfaces { backdrop: Element | null; card: Element | null; header: Element | null }
function findSurfaces(): Surfaces {
  const main = mainEl();
  const card = !main ? null : innerWidth < 768 ? main
    : main.querySelector("[data-panel-group] > [data-panel]") ?? main.querySelector(":scope > [data-app-content-shell]") ?? main;
  return { backdrop: document.querySelector("[data-cf-backdrop]"), card, header: main?.querySelector("header[data-cf-scroll-header]") ?? null };
}

function surfaceAt(pill: Element, r: DOMRect, gen: number, s: Surfaces): Rgb[] {
  let c: Rgb[] = [[1, 1, 1]];
  c = paint(c, opsOf(document.documentElement, null, gen), r);
  if (s.backdrop) for (const pseudo of ["::before", "::after"]) c = paint(c, opsOf(s.backdrop, pseudo, gen), r);
  if (pill.closest('[data-sidebar="sidebar"]')) return c; // the drawer sits flat on the backdrop
  if (s.card) for (const pseudo of ["::before", "::after", null]) c = paint(c, opsOf(s.card, pseudo, gen), r);
  return c;
}

/**
 * The title fade (css.ts `header[data-cf-scroll-header]::before`: the card colour, 80% → 55% → clear, a little
 * taller than the header) lies between the chat and the header pills, so content passing under a pill is already
 * veiled by it. Its colour at the pill's vertical centre, or null for pills not over it. By position, not DOM: the
 * phone's drawer toggle is a fixed overlay outside the header, over the same fade. Without it
 * the estimate treated a photo under the title as bare and asked for far more fill than the eye needs.
 */
function veilAt(header: Element | null, r: DOMRect): Rgba | null {
  if (!header) return null;
  const cs = getComputedStyle(header, "::before");
  if (cs.content === "none" || !cs.backgroundImage.startsWith("linear-gradient(")) return null;
  const hr = header.getBoundingClientRect();
  const top = hr.top + (parseFloat(cs.top) || 0);
  const height = hr.height - (parseFloat(cs.top) || 0) - (parseFloat(cs.bottom) || 0);
  if (height <= 0) return null;
  const y = r.top + r.height / 2;
  if (y < top || y > top + height || r.right < hr.left || r.left > hr.right) return null; // not over the fade
  const t = (y - top) / height;
  const stops: { at: number; c: Rgba }[] = [];
  const parts = splitTop(cs.backgroundImage.slice(16, -1));
  parts.forEach((part, i) => {
    const m = /^(.*\))\s+(-?[\d.]+)%$/.exec(part) ?? /^(.*\))$/.exec(part);
    const c = m && rgba(m[1]);
    if (c) stops.push({ at: m[2] !== undefined ? parseFloat(m[2]) / 100 : i / Math.max(1, parts.length - 1), c });
  });
  if (!stops.length) return null;
  let k = 0;
  while (k < stops.length - 1 && stops[k + 1].at < t) k++;
  const a = stops[k], b = stops[Math.min(k + 1, stops.length - 1)];
  const f = b.at > a.at ? Math.min(1, Math.max(0, (t - a.at) / (b.at - a.at))) : 0;
  const alpha = a.c.a + (b.c.a - a.c.a) * f;
  return alpha > 0 ? { c: a.c.a >= b.c.a ? a.c.c : b.c.c, a: alpha } : null;
}

/* ── Hazards: chat content that differs from the card ─────────────────────────────────────────── */

/** Assumed for media we can't read (cross-origin, video, iframes): busy, so both a dark and a bright patch. */
const BUSY: Rgb[] = [[0.2, 0.2, 0.2], [0.88, 0.88, 0.88]];
type Hazard = { gen: number; layer: Rgba[] } | null; // colours laid over the card (opaque for media)
const hazards = new WeakMap<Element, Hazard>();
const imageColours = new WeakMap<HTMLImageElement, Rgb[] | "pending">();

/** An image's darkest and brightest colours, from an 8×8 copy. The decode and downscale are async
 *  (createImageBitmap): drawing a 880×1760 PNG attachment synchronously cost the rescan ~100ms headless. Until
 *  it is ready (and for cross-origin images, whose pixels are unreadable) the image counts as busy. */
function imageRange(img: HTMLImageElement, onReady: () => void): Rgb[] {
  const hit = imageColours.get(img);
  if (hit && hit !== "pending") return hit;
  if (!hit && typeof createImageBitmap === "function") {
    imageColours.set(img, "pending");
    createImageBitmap(img, { resizeWidth: 8, resizeHeight: 8, resizeQuality: "low" }).then((bmp) => {
      let out = BUSY;
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 8;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        ctx.drawImage(bmp, 0, 0);
        const d = ctx.getImageData(0, 0, 8, 8).data; // throws for a cross-origin image
        let lo: Rgb = [1, 1, 1], hi: Rgb = [0, 0, 0];
        for (let i = 0; i < d.length; i += 4) {
          const px: Rgb = [d[i] / 255, d[i + 1] / 255, d[i + 2] / 255];
          if (lum(px) < lum(lo)) lo = px;
          if (lum(px) > lum(hi)) hi = px;
        }
        out = [lo, hi];
      } catch { /* tainted: busy */ }
      bmp.close();
      imageColours.set(img, out);
      hazards.delete(img);
      onReady();
    }, () => imageColours.set(img, BUSY));
  }
  return BUSY;
}

function classify(el: Element, gen: number, onChange: () => void): Hazard {
  const tag = el.tagName;
  if (tag === "IMG" || tag === "VIDEO" || tag === "CANVAS" || tag === "IFRAME") {
    const r = el.getBoundingClientRect();
    if (Math.min(r.width, r.height) < MIN_MEDIA) return null;
    if (tag === "IMG") {
      const img = el as HTMLImageElement;
      if (!img.complete || !img.naturalWidth) {
        img.addEventListener("load", () => { hazards.delete(img); onChange(); }, { once: true });
        return null;
      }
      return { gen, layer: imageRange(img, onChange).map((c) => ({ c, a: 1 })) };
    }
    return { gen, layer: BUSY.map((c) => ({ c, a: 1 })) };
  }
  const bg = rgba(getComputedStyle(el).backgroundColor);
  return bg && bg.a >= MIN_BG_ALPHA ? { gen, layer: [bg] } : null;
}

/* ── The wash a pill needs ────────────────────────────────────────────────────────────────────── */

/** Worst contrast of the pill's glyphs over these backdrops with a fill of alpha `a`. */
function worst(p: Pill, bgs: Rgb[], a: number): number {
  let w = Infinity;
  for (const b of bgs) {
    const seen: Rgb = [Math.min(1, b[0] * p.bright), Math.min(1, b[1] * p.bright), Math.min(1, b[2] * p.bright)];
    w = Math.min(w, contrast(p.glyph, over(seen, { c: p.fill, a })));
  }
  return w;
}

/** The smallest wash (0..1, steps of 0.1) that brings the pill to its target; if none does, the one that
 *  helps most (0 when a fill can't help: it only ever pushes toward the theme's own surface). */
function washFor(p: Pill, bgs: Rgb[]): number {
  const target = p.text ? 4.5 : 3;
  let best = 0, bestC = 0;
  for (let s = 0; s <= 10; s++) {
    const c = worst(p, bgs, (s / 10) * WASH_MAX);
    if (c >= target) return s / 10;
    if (c > bestC + 0.01) { best = s / 10; bestC = c; }
  }
  return best;
}

/* ── Mount ────────────────────────────────────────────────────────────────────────────────────── */

export function mountPillContrast(): () => void {
  let gen = 0;
  let pills: Pill[] = [];
  let bands: Band[] = [];
  const observed = new Set<Element>();
  let timer = 0, idle = 0, frame = 0, dead = false;
  // ?cf-perf: window.__cfPillContrast.stats (ms; t* are cumulative marks within the last rescan).
  const stats = { rescans: 0, rescanLast: 0, rescanMax: 0, tWall: 0, tPills: 0, tHaz: 0, observed: 0, ioCalls: 0, ioLast: 0, ioMax: 0, writes: 0 };

  const write = (p: Pill, wash: number) => {
    const v = String(wash);
    if (p.wash === v) return;
    p.wash = v;
    p.el.style.setProperty("--cf-pill-wash", v); // explicit 0 too: nested pills must not inherit an outer one's
    stats.writes++;
  };

  const update = (band: Band) => {
    for (const p of band.pills) {
      const bgs = [...p.base];
      for (const [el, r] of p.card ? band.inside : []) {
        if (r.right <= p.rect.left - REACH || r.left >= p.rect.right + REACH) continue;
        const h = hazards.get(el);
        if (!h) continue;
        for (const base of p.base) for (const l of h.layer) bgs.push(p.veil ? over(over(base, l), p.veil) : over(base, l));
      }
      const wash = washFor(p, bgs);
      p.before = worst(p, bgs, 0);
      p.after = worst(p, bgs, wash * WASH_MAX);
      write(p, wash);
    }
  };

  const onEntries = (band: Band) => (entries: IntersectionObserverEntry[]) => {
    const t = performance.now();
    for (const e of entries) {
      if (e.isIntersecting) band.inside.set(e.target, e.boundingClientRect);
      else band.inside.delete(e.target);
    }
    update(band);
    const ms = performance.now() - t;
    stats.ioCalls++; stats.ioLast = ms; stats.ioMax = Math.max(stats.ioMax, ms);
  };

  /** Groups pills into a top and a bottom band; one IntersectionObserver each, rebuilt only when a band moves. */
  const placeBands = () => {
    const vh = innerHeight;
    const groups = [pills.filter((p) => p.rect.top < vh / 2), pills.filter((p) => p.rect.top >= vh / 2)];
    const next: Band[] = [];
    for (const group of groups) {
      if (!group.length) continue;
      const top = Math.max(0, Math.floor(Math.min(...group.map((p) => p.rect.top)) - REACH));
      const bottom = Math.min(vh, Math.ceil(Math.max(...group.map((p) => p.rect.bottom)) + REACH));
      const key = `${top}:${bottom}:${vh}`;
      const old = bands.find((b) => b.key === key);
      if (old) { old.pills = group; next.push(old); continue; }
      const band: Band = { key, pills: group, inside: new Map(), io: null! };
      band.io = new IntersectionObserver(onEntries(band), { rootMargin: `${-top}px 0px ${-(vh - bottom)}px 0px` });
      for (const el of observed) band.io.observe(el);
      next.push(band);
    }
    for (const b of bands) if (!next.includes(b)) b.io.disconnect();
    bands = next;
  };

  /** A full rescan finds the pills and estimates their surfaces (after layout, theme, prefs or wallpaper changes,
   *  and every FULL_EVERY-th time while the DOM churns, for pills that come and go such as scroll-to-latest).
   *  The others only discover new hazards: ~0.3ms of querySelectorAll on a long thread, headless. */
  let full = true, sinceFull = 0;
  const FULL_EVERY = 4; // × RESCAN_MS: a new pill gets its wash within ~2s while bb streams
  const findPills = () => {
    const prev = new Map(pills.map((p) => [p.el, p]));
    const next: Pill[] = [];
    const surfaces = findSurfaces();
    for (const el of queryPills()) {
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const before = getComputedStyle(el, "::before");
      const filter = before.backdropFilter || (before as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter || "none";
      if (before.content === "none" || filter === "none") continue; // not glass in this layout
      const cs = getComputedStyle(el);
      const old = prev.get(el);
      next.push({
        el, rect,
        text: old?.text ?? el.matches(TEXT),
        // In the drawer (phones): over the backdrop, never over chat content (the pane slides away from it).
        card: !el.closest('[data-sidebar="sidebar"]'),
        glyph: rgba(cs.color)?.c ?? [0, 0, 0],
        fill: rgba(`rgb(${cs.getPropertyValue("--cf-pill-tint").trim() || "255 255 255"})`)?.c ?? [1, 1, 1],
        bright: parseFloat(/brightness\(([\d.]+)\)/.exec(filter)?.[1] ?? "1"),
        base: surfaceAt(el, rect, gen, surfaces),
        veil: el.closest('[data-sidebar="sidebar"]') ? null : veilAt(surfaces.header, rect),
        wash: old?.wash ?? "", before: 0, after: 0,
      });
    }
    for (const [el, p] of prev) if (!next.some((n) => n.el === el) && el.isConnected) { el.style.removeProperty("--cf-pill-wash"); p.wash = ""; }
    pills = next;
    placeBands();
  };

  const rescan = () => {
    idle = 0;
    if (dead) return;
    const t = performance.now();
    if (full || ++sinceFull >= FULL_EVERY || pills.some((p) => !p.el.isConnected)) {
      full = false; sinceFull = 0;
      ensureWall(() => { gen++; schedule(0); });
      stats.tWall = performance.now() - t;
      watchMain();
      findPills();
      stats.tPills = performance.now() - t;
    }
    // Hazards: classify new ones (once per generation), observe them in every band.
    const fresh: Element[] = [];
    const drop = (el: Element) => { observed.delete(el); for (const b of bands) { b.io.unobserve(el); b.inside.delete(el); } };
    for (const sc of mainEl()?.querySelectorAll(SCROLLERS) ?? []) {
      for (const el of sc.querySelectorAll(HAZARDS)) {
        let h = hazards.get(el);
        if (h === undefined || (h && h.gen !== gen)) { h = classify(el, gen, () => schedule(RESCAN_MS)); hazards.set(el, h); }
        if (h && !observed.has(el)) { observed.add(el); fresh.push(el); }
        else if (!h && observed.has(el)) drop(el);
      }
    }
    for (const el of observed) if (!el.isConnected) drop(el);
    for (const el of fresh) for (const b of bands) b.io.observe(el);
    stats.tHaz = performance.now() - t;
    for (const b of bands) update(b);
    const ms = performance.now() - t;
    stats.observed = observed.size;
    stats.rescans++; stats.rescanLast = ms; stats.rescanMax = Math.max(stats.rescanMax, ms);
  };

  /** Rescans in idle time (Safari < 26 has no requestIdleCallback: a timeout). `delay` 0 for layout and theme
   *  changes (next frame), RESCAN_MS for DOM churn (bb streaming a reply mutates the DOM continuously). */
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o: { timeout: number }) => number; cancelIdleCallback?: (n: number) => void };
  const ric = (cb: () => void) => (w.requestIdleCallback ? w.requestIdleCallback(cb, { timeout: 300 }) : window.setTimeout(cb, 0));
  const unric = (n: number) => (w.cancelIdleCallback ? w.cancelIdleCallback(n) : clearTimeout(n));
  function schedule(delay: number) {
    if (delay === 0) full = true;
    if (dead || idle) return;
    if (delay === 0) {
      clearTimeout(timer); timer = 0;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = 0; if (!idle) idle = ric(rescan); });
      return;
    }
    if (!timer) timer = window.setTimeout(() => { timer = 0; if (!idle) idle = ric(rescan); }, delay);
  }

  const dom = new MutationObserver(() => schedule(RESCAN_MS));
  dom.observe(document.body, { childList: true, subtree: true });
  // Theme (class) and prefs/wallpaper (inline variables on <html>, written only when they change).
  // Once more 300ms later: bb's controls fade their colour (transition-colors), so a glyph read right after a
  // theme switch is mid-fade (the scroll-to-latest arrow read dark in dark mode and took a full wash for nothing).
  let settle = 0;
  const theme = new MutationObserver(() => {
    gen++; schedule(0);
    clearTimeout(settle);
    settle = window.setTimeout(() => { gen++; schedule(0); }, 300);
  });
  theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  const onResize = () => { gen++; schedule(0); };
  addEventListener("resize", onResize);
  // The card moves when the sidebar opens or closes (desktop): pills and hazards shift sideways.
  const moved = new ResizeObserver(() => schedule(0));
  let watched: Element | null = null;
  const watchMain = () => {
    const main = mainEl();
    if (main === watched) return;
    if (watched) moved.unobserve(watched);
    if (main) moved.observe(main);
    watched = main;
  };
  // The first look waits a second: bb is still booting, and pills start clear (the default) anyway.
  schedule(1000);

  if (perfEnabled()) {
    (window as unknown as Record<string, unknown>).__cfPillContrast = {
      stats,
      pills: () => pills.map((p) => ({ el: p.el, text: p.text, wash: p.wash, before: +p.before.toFixed(2), after: +p.after.toFixed(2), base: p.base.map((c) => c.map((v) => Math.round(v * 255))), hazards: bands.reduce((n, b) => n + (b.pills.includes(p) ? b.inside.size : 0), 0), veil: p.veil ? +p.veil.a.toFixed(2) : 0 })),
      rescan: (all = true) => { full ||= all; rescan(); },
    };
  }

  return () => {
    dead = true;
    clearTimeout(timer);
    clearTimeout(settle);
    cancelAnimationFrame(frame);
    if (idle) unric(idle);
    dom.disconnect();
    theme.disconnect();
    moved.disconnect();
    removeEventListener("resize", onResize);
    for (const b of bands) b.io.disconnect();
    for (const p of pills) p.el.style.removeProperty("--cf-pill-wash");
    delete (window as unknown as Record<string, unknown>).__cfPillContrast;
  };
}

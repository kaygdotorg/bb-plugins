/**
 * Pre-blurred wallpapers: the blur is rendered once, not on every repaint.
 *
 * A live `filter: blur(75px)` over a full-size wallpaper is re-rasterised whenever the layer
 * repaints (resizes, panels opening, sometimes scrolling). A blurred image has no fine
 * detail, so it is rendered here once per (wallpaper, blur) into a small canvas: 1/k of the
 * viewport with k growing with the blur (up to 1/8 at 75px), the blur and saturation baked
 * in. Upscaling that small image is itself a soft blur, so it looks the same. css.ts shows
 * it as a plain background (--cf-wall-side / --cf-wall-card) and drops the live filter
 * (--cf-side-filter / --cf-card-filter: none) once it is ready.
 *
 * Browsers without canvas filters (Safari) keep the live filter: nothing is set here.
 */
type Layer = "side" | "card";
const SATURATE: Record<Layer, number> = { side: 120, card: 140 };

const root = () => document.documentElement.style;
let source: string | null = null;
const blurs: Record<Layer, number> = { side: 0, card: 0 };
const urls: Partial<Record<Layer, string>> = {};
const rendered: Partial<Record<Layer, string>> = {}; // key of what each layer shows
let image: { src: string; img: Promise<HTMLImageElement> } | null = null;
let timer = 0;

function canvasFilterWorks(): boolean {
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx || !("filter" in ctx)) return false;
  ctx.filter = "blur(2px)";
  return ctx.filter === "blur(2px)";
}
const supported = canvasFilterWorks();

function load(src: string): Promise<HTMLImageElement> {
  if (image?.src === src) return image.img;
  const img = new Image();
  img.decoding = "async";
  const done = new Promise<HTMLImageElement>((resolve, reject) => {
    img.onload = () => resolve(img);
    img.onerror = reject;
  });
  img.src = src;
  image = { src, img: done };
  return done;
}

/** Renders one layer: the wallpaper, cover-fitted to the viewport, blurred and saturated. */
async function render(img: HTMLImageElement, blur: number, saturate: number): Promise<string> {
  const k = Math.min(8, Math.max(1, blur / 8));
  const w = Math.max(16, Math.round(window.innerWidth / k));
  const h = Math.max(16, Math.round(window.innerHeight / k));
  const r = blur / k;
  // Draw past the edges by 2r so the blur never fades the borders to transparent.
  const m = Math.ceil(2 * r);
  const scale = Math.max((w + 2 * m) / img.naturalWidth, (h + 2 * m) / img.naturalHeight);
  const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  ctx.filter = `blur(${r}px) saturate(${saturate}%)`;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.9));
  if (!blob) throw new Error("canvas export failed");
  return URL.createObjectURL(blob);
}

function clear(layer: Layer) {
  root().removeProperty(`--cf-wall-${layer}`);
  root().removeProperty(`--cf-${layer}-filter`);
  if (urls[layer]) URL.revokeObjectURL(urls[layer]!);
  delete urls[layer];
  delete rendered[layer];
}

async function update() {
  timer = 0;
  if (!supported || !source) { clear("side"); clear("card"); return; }
  const src = source;
  try {
    const img = await load(src);
    for (const layer of ["side", "card"] as const) {
      const blur = blurs[layer];
      const key = `${src.length}:${src.slice(-64)}:${blur}:${window.innerWidth}x${window.innerHeight}`;
      if (rendered[layer] === key) continue;
      if (blur <= 0) { clear(layer); continue; } // no blur wanted: the plain wallpaper
      const url = await render(img, blur, SATURATE[layer]);
      if (source !== src) { URL.revokeObjectURL(url); return; } // the wallpaper changed meanwhile
      const old = urls[layer];
      urls[layer] = url;
      rendered[layer] = key;
      root().setProperty(`--cf-wall-${layer}`, `url("${url}")`);
      root().setProperty(`--cf-${layer}-filter`, "none");
      if (old) URL.revokeObjectURL(old);
    }
  } catch {
    clear("side");
    clear("card"); // keep the live filter
  }
}

function schedule() {
  clearTimeout(timer);
  timer = window.setTimeout(update, 60);
}

/** The wallpaper changed (or none). */
export function preblurSource(src: string | null) {
  if (src === source) return;
  source = src;
  schedule();
}

/** A blur setting changed (0 = off). */
export function preblurBlurs(side: number, card: number) {
  if (side === blurs.side && card === blurs.card) return;
  blurs.side = side;
  blurs.card = card;
  schedule();
}

// Much larger windows would upscale the small image further: re-render after a resize.
let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => { delete rendered.side; delete rendered.card; schedule(); }, 400);
}, { passive: true });

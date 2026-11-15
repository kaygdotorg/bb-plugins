/**
 * The wordmark at the top of the sidebar (Settings → Wordmark): a short text in a Google
 * Font, "bb" in Dancing Script by default. It sits in bb's top reserve row
 * (`[data-testid="app-sidebar-top-reserve-row"]`), to the right of the sidebar toggle pill and
 * left of the back/forward toolbar. The font is installed locally like the other fonts (its
 * @font-face comes with font_faces), so there's no Google request at runtime.
 *
 * bb re-renders the row on navigation, so the element is re-attached on a light 1s check.
 *
 * Alignment: script fonts carry their ink very unevenly in the line box (tall loops, low
 * baselines, swashes), so no fixed offset centres every font. Once the font has loaded, the
 * ink box of the actual text is measured (canvas measureText) and the wordmark is shifted so
 * the INK's centre sits on the row's centre line (the back/forward toolbar's centre) and the ink
 * starts one pill gap after the toggle pill. On phones the toggle is hidden while the drawer is
 * open (pills-phone.ts), so the ink starts at the 20px side inset instead, like Claude's iOS app.
 * The line box is tall enough that swashes and descenders are never clipped.
 */
import { R } from "./selectors";
import { s } from "./pills";

const ROW = '[data-sidebar="sidebar"] [data-testid="app-sidebar-top-reserve-row"]';

let brand = { text: "", font: "" };
let el: HTMLSpanElement | null = null;

/** The toggle pill's right edge (it is a fixed overlay at the row's left) plus one pill gap. */
const TOGGLE = '[data-sidebar="trigger"]';
const GAP = 8;
/** Phones: the side inset (pills-phone.ts --cf-ph-side). */
const PHONE = "(max-width: 767px)";
const PHONE_INSET = 20;

const CSS = `
${R} ${ROW} { justify-content: space-between; }
${R} [data-cf-brand] {
  /* Starts after the toggle pill; brand.ts nudges it by the font's ink (--cf-brand-dx/dy). */
  margin-left: var(--cf-brand-left, ${s(54)}); /* toggle inset 10 + 36px pill + 8px gap */
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--cf-brand-font, cursive), cursive;
  font-size: ${s(24)};
  font-weight: 600;
  color: var(--foreground);
  /* A tall line box (and side padding) so loops, swashes and descenders never clip. */
  line-height: 1.6;
  padding-inline: 0.15em;
  translate: var(--cf-brand-dx, 0) var(--cf-brand-dy, 0);
  user-select: none;
}
${R} [data-cf-brand]:empty { display: none; }
`;

const quote = (family: string) => `"${family.replace(/["\\]/g, "")}"`;

function render() {
  if (!el) return;
  el.textContent = brand.text.trim();
  el.style.setProperty("--cf-brand-font", brand.font ? quote(brand.font) : "cursive");
  el.setAttribute("aria-label", brand.text.trim());
  void align();
}

/**
 * Centres the text's INK on the row's centre line and starts it one gap after the toggle
 * pill. Runs after the font has loaded (fonts arrive with font_faces, a moment after mount).
 */
async function align() {
  const node = el;
  if (!node || !node.textContent) return;
  const cs = getComputedStyle(node);
  const font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  try { await document.fonts.load(font, node.textContent); } catch { /* fall back to whatever renders */ }
  if (node !== el) return;
  const ctx = document.createElement("canvas").getContext("2d");
  if (!ctx) return;
  ctx.font = font;
  const m = ctx.measureText(node.textContent);
  // Ink box relative to the baseline / text start.
  const inkTop = -m.actualBoundingBoxAscent, inkBottom = m.actualBoundingBoxDescent;
  const fontBox = m.fontBoundingBoxAscent + m.fontBoundingBoxDescent;
  // In the line box, the baseline sits at half-leading + fontBoundingBoxAscent.
  const lineH = parseFloat(cs.lineHeight) || fontBox;
  const baseline = (lineH - fontBox) / 2 + m.fontBoundingBoxAscent;
  const inkMid = baseline + (inkTop + inkBottom) / 2;
  // Onto the back/forward toolbar's centre line when it is there, else the row's.
  const rowEl0 = node.parentElement;
  const line = rowEl0?.querySelector(":scope > div:has(> button)")?.getBoundingClientRect() ?? rowEl0?.getBoundingClientRect();
  const dyNow = parseFloat(node.style.getPropertyValue("--cf-brand-dy")) || 0;
  const top = node.getBoundingClientRect().top - dyNow; // the element's top without our nudge
  const dy = line && line.height > 0 ? line.top + line.height / 2 - (top + inkMid) : lineH / 2 - inkMid;
  node.style.setProperty("--cf-brand-dy", `${dy.toFixed(2)}px`);
  // Horizontal: the ink's left edge one gap after the toggle pill.
  // The row's content box starts after its own padding; the sidebar may still be sliding in
  // on load, so this runs again when the row settles (mountBrand observes it).
  const toggle = document.querySelector<HTMLElement>(TOGGLE)?.getBoundingClientRect();
  const rowEl = node.parentElement;
  const phone = matchMedia(PHONE).matches;
  if (rowEl && (phone || (toggle && toggle.width > 0))) {
    const row = rowEl.getBoundingClientRect();
    const contentLeft = row.left + (parseFloat(getComputedStyle(rowEl).paddingLeft) || 0);
    const inkLeft = (parseFloat(cs.paddingLeft) || 0) - m.actualBoundingBoxLeft; // ink start inside the element
    const scale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cf-ui-scale")) || 1;
    const start = phone ? row.left + PHONE_INSET * scale : toggle!.right + GAP * scale;
    node.style.setProperty("--cf-brand-left", `${(start - contentLeft - inkLeft).toFixed(2)}px`);
  }
}

/** Settings changed (the overlay's sync calls this). */
export function applyBrand(next: { text: string; font: string }) {
  brand = next;
  render();
}

export function mountBrand(): () => void {
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = CSS;
  document.head.append(style);

  // Re-measure when the row moves or resizes (the sidebar sliding in, a resize, a wider font).
  const settle = new ResizeObserver(() => void align());
  let watched: Element | null = null;
  const attach = () => {
    const row = document.querySelector<HTMLElement>(ROW);
    if (!row) return;
    // The toggle pill's size comes from the pill tokens: when it changes, so does the wordmark's start.
    const toggle = document.querySelector(TOGGLE);
    if (toggle && toggle !== watched) { if (watched) settle.unobserve(watched); watched = toggle; settle.observe(toggle); }
    if (el && row.contains(el)) return;
    el ??= document.createElement("span");
    el.setAttribute("data-cf-brand", "");
    el.setAttribute("role", "img"); // a wordmark: read as one name, not as letters
    row.prepend(el);
    settle.disconnect();
    settle.observe(row);
    if (watched) settle.observe(watched);
    render();
    window.setTimeout(() => void align(), 600); // after the sidebar's slide-in on load
  };
  attach();
  const timer = window.setInterval(attach, 1000);
  // Fonts and the interface size can change the ink box: re-measure then.
  const realign = () => void align();
  document.fonts.addEventListener("loadingdone", realign);
  window.addEventListener("resize", realign, { passive: true });
  const phone = matchMedia(PHONE);
  phone.addEventListener("change", realign);
  return () => {
    window.clearInterval(timer);
    settle.disconnect();
    document.fonts.removeEventListener("loadingdone", realign);
    window.removeEventListener("resize", realign);
    phone.removeEventListener("change", realign);
    el?.remove();
    el = null;
    style.remove();
  };
}

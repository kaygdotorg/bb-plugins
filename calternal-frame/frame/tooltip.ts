/**
 * Warm tooltips, app-wide (our own implementation of the "warm tooltip" idea).
 *
 *   - One shared delay: the first tooltip waits, then pops from its trigger (scale and a
 *     touch of blur, ease-out). While the group is warm (shortly after a tooltip closed, or
 *     while one is open) the next one opens instantly, and an open tooltip glides to the new
 *     trigger instead of popping again.
 *   - Labels come from bb's own markup: aria-label or title, plus aria-keyshortcuts as a
 *     shortcut chip. Only controls that show no text of their own get one (icon buttons).
 *   - bb's own tooltips and the browser's native title popups are suppressed (css.ts and
 *     here), so there is exactly one tooltip style.
 * Mouse and keyboard focus only; touch devices keep bb's long-press behaviour.
 */
const DELAY = 450;        // cold: how long the first hover waits
const WARM_WINDOW = 700;  // after closing, how long the next hover opens instantly
const GAP = 8;
const MARGIN = 8;
const GRACE = 80;         // crossing the gap between two triggers keeps the tooltip open

const CANDIDATE = 'button, a[href], [role="button"], [role="tab"], [title], [data-cf-title]';

type Side = "top" | "bottom";

/**
 * Text the element really shows: bb's icon buttons carry screen-reader-only labels (1px,
 * clipped), which must not count as visible text.
 */
function visibleText(el: HTMLElement): string {
  let out = "";
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || !node.textContent?.trim()) continue;
    const box = parent.getBoundingClientRect();
    if (box.width > 2 && box.height > 2) out += ` ${node.textContent}`;
  }
  return out.replace(/\s+/g, " ").trim();
}

/** The tooltip text for an element, or null when it needs none (it shows its own text). */
function labelOf(el: HTMLElement): { text: string; keys: string | null } | null {
  if (el.closest("[data-cf-tip]") || (el as HTMLButtonElement).disabled) return null;
  // A trigger whose menu or popover is open is already showing what it does.
  if (el.getAttribute("aria-expanded") === "true" || el.dataset.state === "open") return null;
  // Text fields never get one (their title/placeholder is not a tooltip).
  if (el.isContentEditable || el.matches("input, textarea, select")) return null;
  const title = el.getAttribute("title") ?? el.dataset.cfTitle ?? null;
  const ariaLabel = el.getAttribute("aria-label");
  const text = (title || ariaLabel || "").trim();
  if (!text) return null;
  // A visible label already says it: no tooltip (titles are explicit, so they always show).
  const visible = visibleText(el);
  if (!title && visible.length > 1 && text.toLowerCase().includes(visible.toLowerCase())) return null;
  // bb often writes the shortcut into the label too ("Settings (⌘,)"): show it once, as the chip.
  const inLabel = /\s*\(([^()]*(?:⌘|⌥|⇧|⌃|Ctrl|Shift|Alt|Cmd|Meta|Option)[^()]*)\)\s*$/i.exec(text);
  const aria = el.getAttribute("aria-keyshortcuts");
  const keys = aria
    ? aria.replace(/\+/g, " ").replace(/Meta/g, "⌘").replace(/Control/g, "Ctrl")
    : inLabel ? inLabel[1].replace(/\s*\+\s*/g, " ").trim() : null;
  return { text: inLabel ? text.slice(0, inLabel.index).trim() : text, keys };
}

/** Moves a native title aside so the browser never shows its own popup next to ours. */
function stashTitle(el: HTMLElement) {
  const title = el.getAttribute("title");
  if (title) {
    el.dataset.cfTitle = title;
    el.removeAttribute("title");
  }
}

export function mountTooltips(): () => void {
  // No device check: only mouse pointer events (and keyboard focus) open a tooltip, so
  // touch taps never do, and hybrid devices keep tooltips for their mouse.
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const tip = document.createElement("div");
  tip.setAttribute("data-cf-tip", "");
  tip.setAttribute("role", "tooltip");
  tip.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  const keys = document.createElement("kbd");
  const arrow = document.createElement("i");
  tip.append(label, keys, arrow);
  document.body.append(tip);

  let trigger: HTMLElement | null = null;
  let openTimer = 0;
  let open = false;
  let warmUntil = 0;
  let graceTimer = 0;

  const place = (el: HTMLElement, glide: boolean) => {
    const r = el.getBoundingClientRect();
    const w = tip.offsetWidth, h = tip.offsetHeight;
    const side: Side = r.top - GAP - h < MARGIN ? "bottom" : "top";
    const x = Math.min(Math.max(r.left + r.width / 2 - w / 2, MARGIN), window.innerWidth - MARGIN - w);
    const y = side === "top" ? r.top - GAP - h : r.bottom + GAP;
    tip.dataset.side = side;
    tip.dataset.glide = glide && !reduce ? "true" : "false";
    tip.style.translate = `${Math.round(x)}px ${Math.round(y)}px`;
    // Arrow points at the trigger's centre even when the tooltip is clamped to the edge.
    arrow.style.left = `${Math.round(r.left + r.width / 2 - x)}px`;
  };

  const show = (el: HTMLElement, instant: boolean) => {
    const info = labelOf(el);
    if (!info) return;
    const glide = open && trigger !== el; // already open elsewhere: slide over
    trigger = el;
    label.textContent = info.text;
    keys.textContent = info.keys ?? "";
    keys.hidden = !info.keys;
    if (!open) tip.dataset.state = "closed"; // start from the pop-in pose
    place(el, glide);
    requestAnimationFrame(() => {
      tip.dataset.state = instant || reduce ? "open-instant" : "open";
      open = true;
    });
  };

  const hide = () => {
    clearTimeout(openTimer);
    if (!open) return;
    open = false;
    trigger = null;
    tip.dataset.state = "closed";
    warmUntil = performance.now() + WARM_WINDOW;
  };

  const onOver = (e: PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    const el = (e.target as Element).closest<HTMLElement>(CANDIDATE);
    if (!el) return;
    clearTimeout(graceTimer);
    if (el === trigger) return;
    stashTitle(el);
    if (!labelOf(el)) return;
    clearTimeout(openTimer);
    const warm = open || performance.now() < warmUntil;
    if (warm) show(el, true);
    else openTimer = window.setTimeout(() => show(el, false), DELAY);
  };
  const onOut = (e: PointerEvent) => {
    const to = e.relatedTarget as Element | null;
    const from = (e.target as Element).closest<HTMLElement>(CANDIDATE);
    if (!from || (to && from.contains(to))) return;
    clearTimeout(openTimer);
    // Moving straight onto another trigger keeps it open (it glides there); a short grace
    // covers the gap between two triggers.
    if (to?.closest(CANDIDATE) && labelOf(to.closest<HTMLElement>(CANDIDATE)!)) return;
    clearTimeout(graceTimer);
    graceTimer = window.setTimeout(hide, open ? GRACE : 0);
  };
  const onFocus = (e: FocusEvent) => {
    const el = e.target as HTMLElement;
    if (!el.matches?.(":focus-visible") || !el.matches(CANDIDATE)) return;
    stashTitle(el);
    show(el, true);
  };
  const onDismiss = () => hide();
  /** bb moves focus around constantly: only the trigger's own blur closes the tooltip. */
  const onBlur = (e: FocusEvent) => { if (e.target === trigger) hide(); };
  /** A live thread scrolls all the time: only close when the trigger itself moved. */
  const onScroll = (e: Event) => {
    if (open && trigger && (e.target as Node).contains?.(trigger)) hide();
  };

  document.addEventListener("pointerover", onOver, { passive: true });
  document.addEventListener("pointerout", onOut, { passive: true });
  document.addEventListener("focusin", onFocus);
  document.addEventListener("focusout", onBlur);
  document.addEventListener("pointerdown", onDismiss, { passive: true, capture: true });
  window.addEventListener("scroll", onScroll, { passive: true, capture: true });
  window.addEventListener("blur", onDismiss);
  return () => {
    clearTimeout(openTimer);
    clearTimeout(graceTimer);
    document.removeEventListener("pointerover", onOver);
    document.removeEventListener("pointerout", onOut);
    document.removeEventListener("focusin", onFocus);
    document.removeEventListener("focusout", onBlur);
    document.removeEventListener("pointerdown", onDismiss, { capture: true });
    window.removeEventListener("scroll", onScroll, { capture: true });
    window.removeEventListener("blur", onDismiss);
    tip.remove();
  };
}

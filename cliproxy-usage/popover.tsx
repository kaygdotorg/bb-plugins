/**
 * The usage breakdown as a popover over the sidebar footer, with a bubble tail on the hub.
 *
 * Until 2026-11-16 the breakdown was bb's sidebar-footer disclosure: bb draws it in the
 * footer's flow above the row, and with calternal-ui's floating footer pills it ran behind
 * them. kayg asked for "an expansion into a popover that remains within the bounds of the
 * sidebar but with a bubble tail to where it's spawning from", so the footer item is now a
 * plain action and this file draws the popover itself:
 *
 *   - Opens upward from the hub (footer.tsx's overlay, or bb's button without it), inside the
 *     sidebar's left/right edges minus 8px, at most 360px wide, as tall as the room above
 *     the hub (the panel scrolls inside).
 *   - One shape, body and tail: a clip-path path() on the glass layer, so the backdrop blur
 *     and the 1px edge (an SVG stroke of the same path, 2px wide with its outer half clipped)
 *     run around the 12x7px tail without a seam. The tail points at the hub's centre and
 *     stays on the straight part of the edge when the popover is clamped.
 *   - Glass: calternal-ui's tokens when it is installed (--cf-glass, --cf-edge,
 *     --cf-glass-shadow, --cf-glass-fill), standalone fallbacks otherwise.
 *   - Motion: scale + fade from the tail's tip, cubic-bezier(0.23, 1, 0.32, 1), 200ms in and
 *     150ms out. None for keyboard opens or under prefers-reduced-motion. Opacity is animated
 *     on the glass layer itself, never on an ancestor: an ancestor with opacity < 1 becomes
 *     the glass's backdrop root and the blur would see nothing until the fade ends.
 *   - Escape, a click outside, or focus leaving closes it. Focus moves in on open and back to
 *     bb's button on close (when it was inside).
 *   - Portalled into the sidebar element (the phone drawer is a modal sheet: outside it,
 *     clicks and focus are blocked), positioned in viewport pixels against a 0x0 fixed
 *     origin probe, which also corrects for a transformed drawer.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** bb's own footer item (an action; footer.tsx hides its icon under the percentages). */
export const BUTTON = 'li[data-footer-item] > button[aria-label="Provider usage"]';
const HUB = "[data-cliproxy-footer]";
const POP_ID = "cliproxy-usage-popover";

/* Geometry, px. */
const MARGIN = 8;   // from the sidebar's left, right and top edges
const MAX_W = 360;
const RADIUS = 14;  // calternal-ui's surface radius (--cf-radius = 10 + 4)
const TAIL_W = 12;  // tail base width
const TAIL_H = 7;
const TAIL_GAP = 4; // tail tip to the hub's top edge
const FILLET = 2;   // the concave curve where the tail meets the body

/* Motion: Emil Kowalski's ease-out. */
const EASE = "cubic-bezier(0.23, 1, 0.32, 1)";
const OPEN_MS = 200;
const CLOSE_MS = 150;

/* ---- open state, shared with the footer action (app.tsx) and the overlay (footer.tsx) ---- */

let open = false;
let instant = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
let pointerAt = -1e9;

/** footer.tsx calls this just before it presses bb's button, so the open is animated. */
export function notePointer(): void { pointerAt = performance.now(); }

/** The footer action: a press within 400ms of a pointer click on the overlay is a pointer open; anything else (Enter/Space on bb's button) opens without animation. */
export function toggleUsage(): void {
  open = !open;
  instant = performance.now() - pointerAt > 400;
  emit();
}

function closeUsage(now: boolean): void {
  if (!open) return;
  open = false;
  instant = now;
  emit();
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
const snapshot = () => open;

/* ---- shape ---- */

/** Body (w x h, radius r) with the tail hanging from its bottom edge at x = tx, tip at h + TAIL_H. */
function shape(w: number, h: number, tx: number): string {
  const r = Math.min(RADIUS, h / 2, w / 2);
  const b = TAIL_W / 2;
  const t = h + TAIL_H;
  return [
    `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h}`,
    // Right flank: a fillet off the body, then in to a rounded tip.
    `H ${tx + b + FILLET} C ${tx + b - 1} ${h} ${tx + 2} ${t - 1.6} ${tx + 1} ${t - 0.6}`,
    `Q ${tx} ${t} ${tx - 1} ${t - 0.6}`,
    `C ${tx - 2} ${t - 1.6} ${tx - b + 1} ${h} ${tx - b - FILLET} ${h}`,
    `H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`,
  ].join(" ");
}

type Layout = { left: number; top: number; width: number; maxH: number; tx: number };

function measure(button: HTMLElement, origin: DOMRect): Layout | null {
  const sidebar = button.closest<HTMLElement>('[data-sidebar="sidebar"]');
  const anchor = button.parentElement?.querySelector<HTMLElement>(HUB) ?? button;
  if (!sidebar) return null;
  const sb = sidebar.getBoundingClientRect();
  const hub = anchor.getBoundingClientRect();
  const cx = hub.left + hub.width / 2;
  const width = Math.min(MAX_W, sb.width - 2 * MARGIN);
  const left = Math.min(Math.max(cx - width / 2, sb.left + MARGIN), sb.right - MARGIN - width);
  const tip = hub.top - TAIL_GAP;
  const edge = RADIUS + TAIL_W / 2 + FILLET; // keep the tail on the straight part of the edge
  return {
    left: left - origin.left,
    top: tip - origin.top,
    width,
    maxH: Math.max(80, tip - TAIL_H - (sb.top + MARGIN)),
    tx: Math.min(Math.max(cx - left, edge), width - edge),
  };
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* Glass with standalone fallbacks: without calternal-ui the sidebar is opaque, so the
   fallback fill is the sidebar colour at 85% to keep the cards legible over the list. */
const STYLE = `
#${POP_ID} { position: absolute; left: 0; bottom: 0; z-index: 50; transform-origin: var(--cliproxy-tx) 100%; color: var(--sidebar-foreground); }
#${POP_ID} > [data-glass] {
  position: relative; clip-path: var(--cliproxy-shape);
  background: var(--cf-glass-fill, color-mix(in oklab, var(--sidebar) 85%, transparent));
  -webkit-backdrop-filter: var(--cf-glass, blur(16px) saturate(180%));
  backdrop-filter: var(--cf-glass, blur(16px) saturate(180%));
  padding-bottom: ${TAIL_H}px;
}
#${POP_ID} > [data-shadow] {
  position: absolute; inset: 0 0 ${TAIL_H}px 0; border-radius: ${RADIUS}px; pointer-events: none;
  box-shadow: var(--cf-glass-shadow, 0 8px 24px -14px rgb(0 0 0 / 0.5)), 0 2px 8px -4px rgb(0 0 0 / 0.12);
}
#${POP_ID} [data-edge] { position: absolute; inset: 0; overflow: visible; pointer-events: none; }
#${POP_ID} [data-edge] path { fill: none; stroke: var(--cf-edge, rgb(127 127 127 / 0.2)); stroke-width: 2; }
#${POP_ID}:focus-visible { outline: none; }
`;

export function UsagePopover({ children }: { children(dismiss: () => void): ReactNode }) {
  const isOpen = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [mounted, setMounted] = useState(false);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState<Layout | null>(null);
  const [bodyH, setBodyH] = useState(0);
  const originRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const dismiss = useCallback(() => closeUsage(false), []);

  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    return () => style.remove();
  }, []);

  // bb's button tells assistive tech that it opens a dialog, and whether it is open.
  useEffect(() => {
    const button = document.querySelector<HTMLElement>(BUTTON);
    if (!button) return;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", String(isOpen));
    if (isOpen) button.setAttribute("aria-controls", POP_ID); else button.removeAttribute("aria-controls");
  }, [isOpen]);

  // Mount on open; on close, play the exit first (or not), then unmount and hand focus back.
  useEffect(() => {
    if (isOpen) {
      // Reopened mid-exit: drop the exit's held end state.
      for (const a of popRef.current?.getAnimations({ subtree: true }) ?? []) a.cancel();
      const button = document.querySelector<HTMLElement>(BUTTON);
      setHost(button?.closest<HTMLElement>('[data-sidebar="sidebar"]') ?? null);
      setMounted(true);
      return;
    }
    if (!mounted) return;
    const pop = popRef.current;
    const finish = () => {
      const button = document.querySelector<HTMLElement>(BUTTON);
      const inside = !document.activeElement || document.activeElement === document.body || pop?.contains(document.activeElement);
      setMounted(false);
      setLayout(null);
      if (inside) button?.focus({ preventScroll: true });
    };
    if (!pop || instant || reducedMotion()) { finish(); return; }
    const timing = { duration: CLOSE_MS, easing: EASE, fill: "forwards" as const };
    pop.animate([{ transform: "scale(1)" }, { transform: "scale(0.95)" }], timing);
    for (const layer of Array.from(pop.querySelectorAll<HTMLElement>("[data-glass], [data-shadow]"))) layer.animate([{ opacity: 1 }, { opacity: 0 }], timing);
    const timer = window.setTimeout(finish, CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  // Place it, and keep it placed while the sidebar or footer moves.
  useLayoutEffect(() => {
    if (!mounted || !host) return;
    const place = () => {
      const button = document.querySelector<HTMLElement>(BUTTON);
      const origin = originRef.current?.getBoundingClientRect();
      if (!button || !origin) { closeUsage(true); return; }
      setLayout(measure(button, origin));
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(host);
    const hub = document.querySelector(HUB);
    if (hub) ro.observe(hub);
    window.addEventListener("resize", place);
    return () => { ro.disconnect(); window.removeEventListener("resize", place); };
  }, [mounted, host]);

  // The path follows the panel's height (loading -> cards).
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const ro = new ResizeObserver(() => setBodyH(body.offsetHeight));
    ro.observe(body);
    setBodyH(body.offsetHeight);
    return () => ro.disconnect();
  }, [layout !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Enter: focus in, then grow from the tail's tip (unless keyboard or reduced motion).
  const entered = useRef(false);
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!mounted) { entered.current = false; return; }
    if (!pop || !layout || entered.current) return;
    entered.current = true;
    pop.focus({ preventScroll: true });
    if (instant || reducedMotion()) return;
    const timing = { duration: OPEN_MS, easing: EASE };
    pop.animate([{ transform: "scale(0.9)" }, { transform: "scale(1)" }], timing);
    for (const layer of Array.from(pop.querySelectorAll<HTMLElement>("[data-glass], [data-shadow]"))) layer.animate([{ opacity: 0 }, { opacity: 1 }], timing);
  }, [mounted, layout]);

  // Escape, outside click, focus leaving.
  useEffect(() => {
    if (!mounted || !isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation(); // on phones bb would also close the drawer
      closeUsage(true);
    };
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // The hub's own press toggles (app.tsx), so it doesn't count as outside.
      if (popRef.current?.contains(target) || document.querySelector(BUTTON)?.parentElement?.contains(target)) return;
      closeUsage(false);
    };
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && !popRef.current?.contains(next) && !document.querySelector(BUTTON)?.contains(next)) closeUsage(true);
    };
    const pop = popRef.current;
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown, true);
    pop?.addEventListener("focusout", onFocusOut);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
      pop?.removeEventListener("focusout", onFocusOut);
    };
  }, [mounted, isOpen]);

  if (!mounted || !host) return null;
  const width = layout?.width ?? 0;
  const tx = layout?.tx ?? width / 2;
  const d = bodyH ? shape(width, bodyH, tx) : "";
  return createPortal(
    <div ref={originRef} style={{ position: "fixed", left: 0, top: 0, width: 0, height: 0, zIndex: 50 }}>
      <div style={{ position: "absolute", left: layout?.left ?? 0, top: layout?.top ?? 0, width, height: 0, visibility: layout ? undefined : "hidden" }}>
        <div
          id={POP_ID}
          ref={popRef}
          role="dialog"
          aria-label="Provider usage"
          tabIndex={-1}
          style={{ width, ["--cliproxy-tx" as string]: `${tx}px`, ["--cliproxy-shape" as string]: d ? `path("${d}")` : "none" }}
        >
          <div data-shadow="" />
          <div data-glass="">
            <svg data-edge="" width={width} height={bodyH + TAIL_H} aria-hidden="true"><path d={d} /></svg>
            <div ref={bodyRef} className="relative flex flex-col" style={{ maxHeight: layout?.maxH }}>
              {children(dismiss)}
            </div>
          </div>
        </div>
      </div>
    </div>,
    host,
  );
}

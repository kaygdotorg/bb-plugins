/**
 * Animate for the mouse, never for the keyboard (kayg; calternal TASTE.md: "Keyboard actions
 * never animate").
 *
 * The page remembers how it was last driven: a key press sets html[data-cf-input="keys"], a
 * pointer press or move sets "pointer". While it is "keys", every transition finishes at once
 * and bb's open/close animations (menus, popovers, dialogs: anything with data-state) are
 * skipped. Loading spinners and other endless indicators keep running: they are status, not
 * a response to the key.
 *
 * Cost: one attribute write when the mode CHANGES (never per key or per frame), and the CSS is
 * a single attribute selector, so typing stays as fast as before.
 */
import { R } from "./selectors";

const ATTR = "data-cf-input";

const CSS = `
${R}[${ATTR}="keys"] *,
${R}[${ATTR}="keys"] *::before,
${R}[${ATTR}="keys"] *::after {
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}
${R}[${ATTR}="keys"] :is([data-state], [data-cf-voice-pill], [data-cf-tip]) {
  animation-duration: 0s !important;
}
`;

export function mountInputMode(): () => void {
  const root = document.documentElement;
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = CSS;
  document.head.append(style);

  let mode: "keys" | "pointer" = "pointer";
  const set = (next: typeof mode) => {
    if (next === mode) return;
    mode = next;
    root.setAttribute(ATTR, next);
  };
  root.setAttribute(ATTR, mode);

  // Modifier presses alone (⌘ to see shortcut hints) don't switch modes.
  const onKey = (e: KeyboardEvent) => { if (!["Meta", "Control", "Alt", "Shift"].includes(e.key)) set("keys"); };
  const onPointer = () => set("pointer");

  document.addEventListener("keydown", onKey, { capture: true, passive: true });
  document.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  document.addEventListener("pointermove", onPointer, { capture: true, passive: true });
  return () => {
    document.removeEventListener("keydown", onKey, { capture: true });
    document.removeEventListener("pointerdown", onPointer, { capture: true });
    document.removeEventListener("pointermove", onPointer, { capture: true });
    root.removeAttribute(ATTR);
    style.remove();
  };
}

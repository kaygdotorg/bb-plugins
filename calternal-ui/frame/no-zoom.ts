/**
 * No pinch or double-tap zoom on touch screens (kayg: "it zooms into the viewport"). A native app doesn't
 * zoom its chrome; bb is laid out for the screen, so a zoom only ever leaves the page half off screen.
 *
 * Three layers, because iOS honours each in different places:
 *   - the viewport meta gets `maximum-scale=1, user-scalable=no` (respected in home-screen web apps; Safari
 *     proper ignores it for accessibility since iOS 10);
 *   - `touch-action: pan-x pan-y` on <html> (touch-action intersects down the tree, so no element below can
 *     pinch or double-tap zoom; WebKit honours it in Safari too); elements with their own touch-action
 *     (the swipes' `none`) only narrow it further;
 *   - WebKit's `gesturestart`/`gesturechange` cancelled (the pinch itself, as a last resort).
 * Touch screens only (pointer: coarse): a desktop trackpad pinch stays the browser's page zoom.
 * Text fields are 16pt or larger everywhere on phones, so iOS's focus zoom never triggers either.
 */
import { R } from "./selectors";

const CSS = `@media (pointer: coarse) { ${R} { touch-action: pan-x pan-y; } }`;

export function mountNoZoom(): () => void {
  if (!matchMedia("(pointer: coarse)").matches) return () => {};
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = CSS;
  document.head.append(style);

  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const before = meta?.content ?? null;
  if (meta) {
    const parts = meta.content.split(",").map((x) => x.trim()).filter((x) => x && !/^(maximum-scale|user-scalable)\s*=/.test(x));
    meta.content = [...parts, "maximum-scale=1", "user-scalable=no"].join(", ");
  }
  const stop = (e: Event) => e.preventDefault();
  document.addEventListener("gesturestart", stop, { passive: false });
  document.addEventListener("gesturechange", stop, { passive: false });
  return () => {
    document.removeEventListener("gesturestart", stop);
    document.removeEventListener("gesturechange", stop);
    if (meta && before !== null) meta.content = before;
    style.remove();
  };
}

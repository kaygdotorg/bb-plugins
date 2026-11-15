/**
 * Content script: installs the frame for one plugin generation. It adds the stylesheet,
 * the fixed backdrop layer and the root attribute, and paints last session's look from
 * cache straight away. The disposer removes everything, restoring bb exactly.
 */
import { CSS } from "./css";
import { ROOT_ATTR } from "./selectors";
import { applyCachedWallpaper, clearWallpaper } from "./wallpaper";
import { applyCachedPrefs, clearPrefs } from "./prefs";
import { applyCachedAccent, clearAccent } from "./accent";
import { mountTouch } from "./touch";
import { mountTooltips } from "./tooltip";
import { mountComposer } from "./composer";

export function mountFrame(): () => void {
  const style = document.createElement("style");
  style.dataset.bbPlugin = "calternal-ui";
  style.textContent = CSS;
  document.head.appendChild(style);

  // One fixed layer under the whole app: the blurred, tinted wallpaper (see css.ts).
  const backdrop = document.createElement("div");
  backdrop.setAttribute("data-cf-backdrop", "");
  backdrop.setAttribute("aria-hidden", "true");
  document.body.prepend(backdrop);

  const root = document.documentElement;
  root.setAttribute(ROOT_ATTR, "");
  applyCachedWallpaper();
  applyCachedPrefs();
  applyCachedAccent();
  const unmountTouch = mountTouch();
  const unmountTooltips = mountTooltips();
  const unmountComposer = mountComposer();

  return () => {
    unmountComposer();
    unmountTouch();
    unmountTooltips();
    style.remove();
    backdrop.remove();
    root.removeAttribute(ROOT_ATTR);
    clearWallpaper();
    clearPrefs();
    clearAccent();
  };
}

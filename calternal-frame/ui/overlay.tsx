/**
 * Always-mounted app overlay. Keeps the frame in sync with the server (wallpaper, surface
 * effects, fonts, accent) and hosts the usage bars in bb's sidebar footer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { FrameState, rpcContract } from "../shared/contract";
import { CHANGED_EVENT } from "../frame/events";
import { applyWallpaper } from "../frame/wallpaper";
import { applyFontFaces, applyPrefs } from "../frame/prefs";
import { applyAccent } from "../frame/accent";
import { UsageBars } from "./usage-bars";

/** Where the usage bars live: the top of bb's sidebar footer, above its icon row. */
function useSidebarFooterSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const host = document.createElement("div");
    host.dataset.calternalFrameUsage = "";
    // bb re-renders its footer freely; re-attach when the node is dropped. A
    // one-second check is cheaper than observing the whole app's DOM.
    const attach = () => {
      if (host.isConnected) return;
      const footer = document.querySelector('[data-sidebar="sidebar"] [data-sidebar="footer"]');
      if (!footer) return;
      footer.prepend(host);
      setSlot(host);
    };
    attach();
    const timer = window.setInterval(attach, 1000);
    return () => {
      window.clearInterval(timer);
      host.remove();
    };
  }, []);
  return slot;
}

export function FrameOverlay() {
  const rpc = useRpc<typeof rpcContract>();
  const slot = useSidebarFooterSlot();
  const [state, setState] = useState<FrameState | null>(null);

  // What is already applied, so a sync only moves the heavy parts when they changed:
  // the wallpaper image (~1 MB) and the inlined fonts (~300 KB a family).
  const applied = useRef<{ wallpaper?: string; wallpaperSrc?: string | null; fonts?: string }>({});

  const sync = useCallback(async () => {
    try {
      const next = await rpc.call("frame_light", {});
      setState(next);
      applyPrefs({ sidebar: next.sidebar, chat: next.chat, fonts: next.fonts, uiScale: next.uiScale });

      const wallpaperKey = next.wallpaperId ?? `url:${next.wallpaperUrl}`;
      let wallpaper = applied.current.wallpaperSrc ?? null;
      if (applied.current.wallpaper !== wallpaperKey) {
        wallpaper = next.wallpaperId
          ? (await rpc.call("wallpaper_active", {})).dataUrl
          : next.wallpaperUrl || null;
        applyWallpaper(wallpaper);
        applied.current = { ...applied.current, wallpaper: wallpaperKey, wallpaperSrc: wallpaper };
      }
      void applyAccent(next.accent, wallpaper);

      const fontsKey = Object.values(next.fonts).filter((f) => f.on).map((f) => f.family).sort().join("|");
      if (applied.current.fonts !== fontsKey) {
        applyFontFaces((await rpc.call("font_faces", {})).css);
        applied.current = { ...applied.current, fonts: fontsKey };
      }
    } catch {
      // Keep what is applied; the next change event or reload retries.
    }
  }, [rpc]);

  useEffect(() => {
    void sync();
    window.addEventListener(CHANGED_EVENT, sync);
    return () => window.removeEventListener(CHANGED_EVENT, sync);
  }, [sync]);

  if (!slot || !state?.usage.enabled) return null;
  return createPortal(<UsageBars prefs={state.usage} />, slot);
}

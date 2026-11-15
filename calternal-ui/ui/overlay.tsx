/**
 * Always-mounted app overlay. Keeps the frame in sync with the server (wallpaper, surface
 * effects, fonts, accent). Usage in the sidebar footer belongs to the cliproxy-usage plugin.
 */
import { useCallback, useEffect, useRef } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../shared/contract";
import { CHANGED_EVENT } from "../frame/events";
import { applyWallpaper } from "../frame/wallpaper";
import { applyFontFaces, applyPrefs } from "../frame/prefs";
import { applyAccent } from "../frame/accent";
import { registerTimesLoader } from "../frame/times";

export function FrameOverlay() {
  const rpc = useRpc<typeof rpcContract>();

  // What is already applied, so a sync only moves the heavy parts when they changed:
  // the wallpaper image (~1 MB) and the inlined fonts (~300 KB a family).
  const applied = useRef<{ wallpaper?: string; wallpaperSrc?: string | null; fonts?: string }>({});

  const sync = useCallback(async () => {
    try {
      const next = await rpc.call("frame_light", {});
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

  // Lets the swipe module (a content script, no RPC of its own) read message times.
  useEffect(() => {
    registerTimesLoader((threadId) => rpc.call("message_times", { threadId }));
    return () => registerTimesLoader(null);
  }, [rpc]);

  useEffect(() => {
    void sync();
    window.addEventListener(CHANGED_EVENT, sync);
    return () => window.removeEventListener(CHANGED_EVENT, sync);
  }, [sync]);

  return null;
}

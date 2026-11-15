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
import { registerTimesLoader } from "../frame/times";
import { UsageBars } from "./usage-bars";

/**
 * Where the usage bars live: in the sidebar footer, on the same line as bb's icon row
 * (`ul[data-sidebar=menu]`), filling the space right of the last icon. The host is NOT a
 * child of that row: bb counts the row's children to decide which icons move into its
 * "…" overflow, so an extra item would cost an icon. Instead it is positioned over the
 * row's free space and re-measured with one ResizeObserver on the row.
 */
function useSidebarFooterSlot(): HTMLElement | null {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const host = document.createElement("div");
    host.dataset.calternalFrameUsage = "";
    host.style.cssText = "position: absolute; display: flex; align-items: center; min-width: 0;";
    let row: HTMLElement | null = null;

    const place = () => {
      if (!row) return;
      const footer = row.parentElement as HTMLElement;
      const box = footer.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      // The rightmost visible icon button (bb nests them differently on desktop and mobile).
      const iconsRight = Math.max(rowBox.left, ...[...row.querySelectorAll("button")]
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.width > 0)
        .map((r) => r.right));
      const left = iconsRight - box.left + 10;
      const right = box.right - rowBox.right + 2;
      Object.assign(host.style, {
        left: `${left}px`,
        right: `${right}px`,
        top: `${rowBox.top - box.top}px`,
        height: `${rowBox.height}px`,
        visibility: box.width - left - right >= 72 ? "visible" : "hidden",
      });
    };
    const observer = new ResizeObserver(place);

    // bb re-renders its footer freely; re-attach when the node is dropped. A one-second
    // check is far cheaper than observing the whole app's DOM.
    const attach = () => {
      if (host.isConnected && row?.isConnected) return;
      const next = document.querySelector<HTMLElement>('[data-sidebar="sidebar"] [data-sidebar="footer"] > [data-sidebar="menu"]');
      if (!next) return;
      observer.disconnect();
      row = next;
      const footer = row.parentElement as HTMLElement;
      if (getComputedStyle(footer).position === "static") footer.style.position = "relative";
      footer.append(host);
      observer.observe(row);
      place();
      setSlot(host);
    };
    attach();
    const timer = window.setInterval(() => { attach(); place(); }, 1000);
    return () => {
      window.clearInterval(timer);
      observer.disconnect();
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

  if (!slot || !state?.usage.enabled) return null;
  return createPortal(<UsageBars prefs={state.usage} />, slot);
}

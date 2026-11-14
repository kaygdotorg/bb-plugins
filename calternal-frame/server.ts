/**
 * Server entry: wires the modules in server/ to the RPC contract in shared/contract.ts.
 * Handlers stay thin; the logic lives in the modules.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { MAX_UPLOAD_CHARS, rpcContract, type FrameState } from "./shared/contract";
import { createStore } from "./server/store";
import { createWallpapers, unsplashId, uploadId } from "./server/wallpapers";
import { createUnsplash } from "./server/unsplash";
import { createFonts } from "./server/fonts";
import { createUsage } from "./server/usage";

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    unsplashAccessKey: {
      type: "string",
      label: "Unsplash access key",
      description: "Free from unsplash.com/developers (create an app, copy its Access Key). Enables wallpaper search.",
      secret: true,
    },
  });
  let config = await settings.get();
  settings.onChange((next) => { config = next; });
  const unsplashKey = () => config.unsplashAccessKey?.trim() ?? "";

  const store = createStore(bb);
  const wallpapers = createWallpapers(store);
  const unsplash = createUnsplash(unsplashKey);
  const fonts = createFonts(store, bb.log);
  const usage = createUsage(bb);
  wallpapers.migrateLegacy();

  const state = (): FrameState => ({
    ...store.prefs(),
    uploaded: store.get("wallpaper") ?? null,
    wallpaperId: store.get("wallpaperActive") ?? null,
    unsplashReady: unsplashKey() !== "",
    updatedAt: store.updatedAt(),
  });

  bb.rpc.register(rpcContract, {
    frame_get: () => state(),
    frame_light: () => ({ ...state(), uploaded: null }),
    wallpaper_active: () => ({ id: store.get("wallpaperActive") ?? null, dataUrl: store.get("wallpaper") ?? null }),

    frame_set: async (patch) => {
      // Download a newly chosen font first, so a bad family name fails here, visibly.
      for (const font of Object.values(patch.fonts ?? {})) {
        if (font?.on && font.family) await fonts.install(font.family);
      }
      const current = store.prefs();
      const url = patch.wallpaperUrl?.trim();
      if (url && !/^https:\/\//i.test(url)) throw new Error("Use an https:// image URL.");
      store.savePrefs({
        ...current,
        wallpaperUrl: url ?? current.wallpaperUrl,
        // A URL is your own image: it carries no Unsplash credit.
        wallpaperCredit: url !== undefined ? null : current.wallpaperCredit,
        sidebar: { ...current.sidebar, ...patch.sidebar },
        chat: { ...current.chat, ...patch.chat },
        fonts: { ...current.fonts, ...patch.fonts },
        uiScale: patch.uiScale ?? current.uiScale,
        accent: patch.accent ?? current.accent,
        usage: { ...current.usage, ...patch.usage },
      });
      return state();
    },

    wallpaper_upload: ({ dataUrl, thumb }) => {
      const id = uploadId(dataUrl);
      wallpapers.add(id, "upload", dataUrl, thumb ?? null, null);
      wallpapers.activate(id);
      return state();
    },
    wallpaper_clear: () => { wallpapers.clearActive(); return state(); },
    wallpapers_list: () => wallpapers.list(),
    wallpaper_select: ({ id }) => {
      if (!wallpapers.activate(id)) throw new Error("That wallpaper is no longer stored.");
      return state();
    },
    wallpaper_delete: ({ id }) => { wallpapers.remove(id); return state(); },
    wallpaper_get: ({ id }) => {
      const dataUrl = wallpapers.fullImage(id);
      if (!dataUrl) throw new Error("That wallpaper is no longer stored.");
      return { dataUrl };
    },
    wallpaper_thumb: ({ id, thumb }) => { wallpapers.setThumb(id, thumb); return { ok: true }; },

    unsplash_search: ({ query, page }) => unsplash.search(query, page),
    unsplash_use: async ({ id }) => {
      // Already downloaded: switch to the local copy, no network.
      if (wallpapers.activate(unsplashId(id))) return state();
      const photo = await unsplash.download(id);
      if (photo.data.length > MAX_UPLOAD_CHARS) throw new Error("That photo is too large.");
      wallpapers.add(unsplashId(id), "unsplash", photo.data, photo.thumb, photo.credit);
      wallpapers.activate(unsplashId(id));
      return state();
    },

    google_fonts: () => fonts.catalogue(),
    font_faces: async () => ({ css: await fonts.faces() }),
    usage_summary: ({ refresh }) => usage(refresh),
  });
}

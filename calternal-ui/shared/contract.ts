/**
 * The plugin's one source of truth for data shapes: settings, server state and the RPC
 * contract between the app and the server. Imported for types by the app (type-only, so
 * zod stays out of the frontend bundle) and for values by the server.
 */
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** One effect on a surface: a checkbox and its value. */
const effectSchema = z.object({ on: z.boolean(), value: z.number().min(0).max(200) });
const surfaceSchema = z.object({ blur: effectSchema, tint: effectSchema, dim: effectSchema });
/** A font override for one of bb's text surfaces; family is a Google Fonts family name. */
const fontSchema = z.object({ on: z.boolean(), family: z.string().max(120) });
const fontsSchema = z.object({ ui: fontSchema, chat: fontSchema, code: fontSchema, terminal: fontSchema });
const creditSchema = z.object({ name: z.string(), profile: z.string(), photo: z.string() }).nullable();

export const prefsSchema = z.object({
  /** An https:// image URL; ignored while an uploaded or Unsplash wallpaper exists. */
  wallpaperUrl: z.string(),
  /** Unsplash's required attribution for the stored wallpaper, or null for your own image. */
  wallpaperCredit: creditSchema,
  /** The window backdrop behind the left sidebar and right panel. Blur in px; tint and dim in %. */
  sidebar: surfaceSchema,
  /** The floating chat card. */
  chat: surfaceSchema,
  fonts: fontsSchema,
  /** The accent bb's palette follows: the wallpaper's hue, or a custom colour (#rrggbb). */
  accent: z.object({ mode: z.enum(["wallpaper", "custom"]), color: z.string().regex(/^#[\da-fA-F]{6}$/) }),
  /** Interface size in %: scales bb's rem-based text and controls together. */
  uiScale: z.number().min(75).max(150),
  /** Clock format for every time bb shows; "system" leaves bb's own (the browser locale's). */
  clock: z.enum(["24h", "12h", "system"]),
  /** Chat layout: "wide" fills the card (your bubbles right, the agent left); "centered" is bb's 760px column. */
  chatWidth: z.enum(["wide", "centered"]),
});
export type FramePrefs = z.infer<typeof prefsSchema>;
export type SurfacePrefs = z.infer<typeof surfaceSchema>;
export type FontPrefs = z.infer<typeof fontsSchema>;

/** A partial update: surfaces and fonts merge one level deep. */
const prefsPatchSchema = z.object({
  wallpaperUrl: z.string().optional(),
  sidebar: surfaceSchema.partial().optional(),
  chat: surfaceSchema.partial().optional(),
  fonts: fontsSchema.partial().optional(),
  uiScale: z.number().min(75).max(150).optional(),
  clock: z.enum(["24h", "12h", "system"]).optional(),
  chatWidth: z.enum(["wide", "centered"]).optional(),
  accent: z.object({ mode: z.enum(["wallpaper", "custom"]), color: z.string().regex(/^#[\da-fA-F]{6}$/) }).optional(),
});
export type FramePrefsPatch = z.infer<typeof prefsPatchSchema>;

const frameStateSchema = prefsSchema.extend({
  /** A data: URL of the uploaded or Unsplash wallpaper, or null. */
  uploaded: z.string().nullable(),
  /** The active library entry's id (or null): changes exactly when the image does. */
  wallpaperId: z.string().nullable(),
  /** Whether an Unsplash access key is set in this plugin's settings. */
  unsplashReady: z.boolean(),
  updatedAt: z.number(),
});
export type FrameState = z.infer<typeof frameStateSchema>;

const unsplashPhotoSchema = z.object({
  id: z.string(),
  thumb: z.string(),
  color: z.string(),
  alt: z.string(),
  width: z.number(),
  height: z.number(),
  author: z.string(),
  authorProfile: z.string(),
  photoPage: z.string(),
});
export type UnsplashPhoto = z.infer<typeof unsplashPhotoSchema>;

const googleFontSchema = z.object({ family: z.string(), category: z.string() });
export type GoogleFont = z.infer<typeof googleFontSchema>;

export const libraryEntrySchema = z.object({
  id: z.string(),
  source: z.enum(["upload", "unsplash"]),
  thumb: z.string().nullable(),
  credit: creditSchema,
  addedAt: z.number(),
  active: z.boolean(),
});
export type LibraryEntry = z.infer<typeof libraryEntrySchema>;

/** Everything this plugin downloaded or stored, with sizes, for Settings → Storage. */
const assetsSchema = z.object({
  wallpapers: z.array(z.object({
    id: z.string(),
    source: z.enum(["upload", "unsplash"]),
    thumb: z.string().nullable(),
    credit: creditSchema,
    bytes: z.number(),
    active: z.boolean(),
  })),
  fonts: z.array(z.object({
    family: z.string(),
    bytes: z.number(),
    /** The font overrides using it ("UI", "Chat", …); empty when nothing does. */
    usedBy: z.array(z.string()),
  })),
});
export type Assets = z.infer<typeof assetsSchema>;
const assetRefSchema = z.object({ kind: z.enum(["wallpaper", "font"]), id: z.string().min(1).max(160) });

/** Upload cap after the app downscales: a 2560px JPEG is far below this. */
export const MAX_UPLOAD_CHARS = 12_000_000;

export const rpcContract = defineRpcContract({
  frame_get: { input: z.object({}), output: frameStateSchema },
  /** frame_get without the image (uploaded: null), for the always-on sync: a few KB, not ~1 MB. */
  frame_light: { input: z.object({}), output: frameStateSchema },
  /** The active wallpaper image; fetched only when wallpaperId changes. */
  wallpaper_active: { input: z.object({}), output: z.object({ id: z.string().nullable(), dataUrl: z.string().nullable() }) },
  frame_set: { input: prefsPatchSchema, output: frameStateSchema },
  wallpaper_upload: {
    input: z.object({
      dataUrl: z.string().max(MAX_UPLOAD_CHARS).regex(/^data:image\/(jpeg|png|webp|avif);base64,/),
      thumb: z.string().max(400_000).regex(/^data:image\//).optional(),
    }),
    output: frameStateSchema,
  },
  /** Every wallpaper stored locally (uploads and Unsplash downloads), newest first. */
  wallpapers_list: { input: z.object({}), output: z.array(libraryEntrySchema) },
  /** Switches to a stored wallpaper: local only, no network. */
  wallpaper_select: { input: z.object({ id: z.string().max(80) }), output: frameStateSchema },
  wallpaper_delete: { input: z.object({ id: z.string().max(80) }), output: frameStateSchema },
  /** Full image of a stored wallpaper, so the app can make a missing thumbnail. */
  wallpaper_get: { input: z.object({ id: z.string().max(80) }), output: z.object({ dataUrl: z.string() }) },
  wallpaper_thumb: {
    input: z.object({ id: z.string().max(80), thumb: z.string().max(400_000).regex(/^data:image\//) }),
    output: z.object({ ok: z.boolean() }),
  },
  wallpaper_clear: { input: z.object({}), output: frameStateSchema },
  unsplash_search: {
    input: z.object({ query: z.string().min(1).max(100), page: z.number().int().min(1).max(50) }),
    output: z.object({ photos: z.array(unsplashPhotoSchema), totalPages: z.number() }),
  },
  unsplash_use: { input: z.object({ id: z.string().regex(/^[\w-]{1,40}$/) }), output: frameStateSchema },
  google_fonts: { input: z.object({}), output: z.array(googleFontSchema) },
  /** @font-face CSS for the enabled font overrides, with the font files inlined from local storage. */
  font_faces: { input: z.object({}), output: z.object({ css: z.string() }) },
  /** Storage: every stored wallpaper and font with its size. */
  assets_list: { input: z.object({}), output: assetsSchema },
  /** Deletes one stored asset. A font in use is switched off first (bb's own font returns). */
  asset_remove: { input: assetRefSchema, output: assetsSchema },
  /** Deletes every stored asset of a kind that is not in use. */
  assets_prune: { input: z.object({ kind: z.enum(["wallpaper", "font"]) }), output: assetsSchema },
  /** When each conversation row of a thread was created (ms), keyed by bb's timeline row id. */
  message_times: {
    input: z.object({ threadId: z.string().regex(/^thr_[\w-]+$/) }),
    output: z.record(z.string(), z.number()),
  },
});


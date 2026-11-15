// Wallpaper section: current preview, upload / URL / clear, then the stored library and Unsplash search.
import { useEffect, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { FrameState } from "../../shared/contract";
import { makeThumb, toWallpaperDataUrl } from "./images";
import { buttonCls, ErrorLine, inputCls, linkCls, messageOf, Section, type Commit, type Rpc } from "./primitives";
import { UnsplashSearch } from "./unsplash";
import { WallpaperLibrary } from "./wallpaper-library";

export function WallpaperSection({ state, rpc, commit }: { state: FrameState; rpc: Rpc; commit: Commit }) {
  const [url, setUrl] = useState(state.wallpaperUrl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setUrl(state.wallpaperUrl), [state.wallpaperUrl]);

  const run = async (work: () => Promise<FrameState>) => {
    setBusy(true);
    setError(null);
    try {
      commit(await work());
    } catch (e) {
      setError(messageOf(e, "Could not save."));
    } finally {
      setBusy(false);
    }
  };
  const preview = state.uploaded ?? (state.wallpaperUrl || null);
  const credit = state.wallpaperCredit;

  return (
    <Section title="Wallpaper" hint="Shown behind the sidebars and the chat card. An upload or Unsplash photo wins over a URL.">
      <div className="flex flex-wrap gap-4">
        <div className="flex w-36 shrink-0 flex-col gap-2">
          <div
            role="img"
            aria-label="Current wallpaper"
            className="h-24 w-36 rounded-lg border border-border bg-muted bg-cover bg-center"
            style={preview ? { backgroundImage: `url("${preview}")` } : undefined}
          />
          {credit ? (
            <p className="text-xs text-muted-foreground">
              Photo by{" "}
              <a href={credit.profile} target="_blank" rel="noreferrer" className={linkCls}>{credit.name}</a>
              {" "}on{" "}
              <a href={credit.photo} target="_blank" rel="noreferrer" className={linkCls}>Unsplash</a>
            </p>
          ) : null}
        </div>
        <div className="flex min-w-[260px] flex-1 flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <label className={`${buttonCls} cursor-pointer ${busy ? "opacity-50" : ""}`}>
              Upload image
              <input
                type="file"
                accept="image/*"
                className="sr-only"
                disabled={busy}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) void run(async () => {
                    const dataUrl = await toWallpaperDataUrl(file);
                    return rpc.call("wallpaper_upload", { dataUrl, thumb: await makeThumb(dataUrl) });
                  });
                }}
              />
            </label>
            {state.uploaded ? (
              <button type="button" className={buttonCls} disabled={busy} aria-busy={busy} onClick={() => void run(() => rpc.call("wallpaper_clear", {}))}>
                <Icon name="X" className="size-3.5" />
                No wallpaper
              </button>
            ) : null}
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(() => rpc.call("frame_set", { wallpaperUrl: url }));
            }}
          >
            <label className="sr-only" htmlFor="cf-wallpaper-url">Wallpaper image URL</label>
            <input
              id="cf-wallpaper-url"
              className={`${inputCls} flex-1`}
              placeholder="or an https:// image URL"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="submit" className={buttonCls} disabled={busy || url.trim() === state.wallpaperUrl}>Use URL</button>
          </form>
          <ErrorLine message={error} />
        </div>
      </div>
      <WallpaperLibrary state={state} rpc={rpc} commit={commit} />
      <UnsplashSearch ready={state.unsplashReady} rpc={rpc} commit={commit} />
    </Section>
  );
}

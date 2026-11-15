// Wallpaper library grid: wallpapers already stored on this bb server, switchable without network.
import { useEffect, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { FrameState, LibraryEntry } from "../../shared/contract";
import { makeThumb } from "./images";
import { ErrorLine, messageOf, SubHeading, Spinner, type Commit, type Rpc } from "./primitives";

/** Wallpapers already stored on this bb server: switching between them needs no network. */
export function WallpaperLibrary({ state, rpc, commit }: { state: FrameState; rpc: Rpc; commit: Commit }) {
  const [entries, setEntries] = useState<LibraryEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rpc.call("wallpapers_list", {}).then(async (list) => {
      if (cancelled) return;
      setEntries(list);
      // Entries stored before thumbnails existed: make one from the full image, once.
      for (const entry of list.filter((e) => !e.thumb)) {
        try {
          const { dataUrl } = await rpc.call("wallpaper_get", { id: entry.id });
          const thumb = await makeThumb(dataUrl);
          await rpc.call("wallpaper_thumb", { id: entry.id, thumb });
          if (!cancelled) setEntries((prev) => prev?.map((e) => (e.id === entry.id ? { ...e, thumb } : e)) ?? prev);
        } catch {
          // Leave the tile as a plain swatch.
        }
      }
    }, () => { if (!cancelled) setEntries([]); });
    return () => { cancelled = true; };
  }, [rpc, state.updatedAt]);

  if (!entries || entries.length === 0) return null;

  const act = async (id: string, work: () => Promise<FrameState>) => {
    setBusy(id);
    setError(null);
    try {
      commit(await work());
    } catch (e) {
      setError(messageOf(e, "Could not switch wallpaper."));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <SubHeading title="Your wallpapers" hint="stored on this bb server, no download needed" />
      <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
        {entries.map((entry) => (
          <div key={entry.id} className="group relative">
            <button
              type="button"
              aria-pressed={entry.active}
              aria-busy={busy === entry.id}
              disabled={busy !== null}
              title={entry.credit ? `Photo by ${entry.credit.name} on Unsplash` : "Your upload"}
              onClick={() => void act(entry.id, () => rpc.call("wallpaper_select", { id: entry.id }))}
              className={`block aspect-[16/10] w-full overflow-hidden rounded-lg border bg-muted bg-cover bg-center transition-[box-shadow,transform] hover:scale-[1.02] disabled:hover:scale-100 ${entry.active ? "border-transparent ring-2 ring-ring" : "border-border"}`}
              style={entry.thumb ? { backgroundImage: `url("${entry.thumb}")` } : undefined}
            >
              <span className="sr-only">{entry.active ? "Current wallpaper" : "Use this wallpaper"}</span>
              {busy === entry.id ? (
                <span className="flex h-full items-center justify-center bg-popover/60"><Spinner /></span>
              ) : null}
            </button>
            <button
              type="button"
              aria-label="Delete this wallpaper"
              title="Delete"
              disabled={busy !== null}
              onClick={() => void act(entry.id, () => rpc.call("wallpaper_delete", { id: entry.id }))}
              className="absolute right-1 top-1 hidden size-6 items-center justify-center rounded-md bg-popover/85 text-muted-foreground hover:text-foreground group-hover:flex focus-visible:flex"
            >
              <Icon name="X" className="size-3.5" />
            </button>
            {entry.source === "unsplash" ? (
              <span className="pointer-events-none absolute bottom-1 left-1 rounded-md bg-popover/80 px-1 text-[10px] text-muted-foreground">Unsplash</span>
            ) : null}
          </div>
        ))}
      </div>
      <ErrorLine message={error} />
    </div>
  );
}

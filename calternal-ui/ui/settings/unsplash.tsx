// Unsplash search: find a photo and use it as the wallpaper (with attribution kept by the server).
import { useRef, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { UnsplashPhoto } from "../../shared/contract";
import { buttonCls, ErrorLine, inputCls, messageOf, SubHeading, Spinner, type Commit, type Rpc } from "./primitives";

export function UnsplashSearch({ ready, rpc, commit }: { ready: boolean; rpc: Rpc; commit: Commit }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState("");
  const [photos, setPhotos] = useState<UnsplashPhoto[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [searching, setSearching] = useState(false);
  const [using, setUsing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  if (!ready) {
    return (
      <div className="flex flex-col gap-2">
        <SubHeading title="Unsplash" />
        <p className="text-xs text-muted-foreground">
          To search Unsplash, add an Unsplash access key in the Configuration field above (free at unsplash.com/developers).
        </p>
      </div>
    );
  }

  const load = async (q: string, nextPage: number) => {
    const id = ++requestId.current;
    setSearching(true);
    setError(null);
    try {
      const result = await rpc.call("unsplash_search", { query: q, page: nextPage });
      if (id !== requestId.current) return;
      setActive(q);
      setPage(nextPage);
      setTotalPages(result.totalPages);
      setPhotos((prev) => (nextPage === 1 ? result.photos : [...prev, ...result.photos]));
    } catch (e) {
      if (id === requestId.current) setError(messageOf(e, "Search failed."));
    } finally {
      if (id === requestId.current) setSearching(false);
    }
  };

  const use = async (photo: UnsplashPhoto) => {
    setUsing(photo.id);
    setError(null);
    try {
      commit(await rpc.call("unsplash_use", { id: photo.id }));
    } catch (e) {
      setError(messageOf(e, "Could not use that photo."));
    } finally {
      setUsing(null);
    }
  };

  const q = query.trim();
  return (
    <div className="flex flex-col gap-2">
      <SubHeading title="Unsplash" hint="search free photos" />
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (q) void load(q, 1);
        }}
      >
        <div className="relative flex-1">
          <Icon name="Search" className="pointer-events-none absolute left-2 top-2.5 size-3.5 text-muted-foreground" />
          <label className="sr-only" htmlFor="cf-unsplash-q">Search Unsplash</label>
          <input
            id="cf-unsplash-q"
            className={`${inputCls} w-full pl-7`}
            placeholder="Search Unsplash photos"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <button type="submit" className={buttonCls} disabled={!q || searching} aria-busy={searching}>
          {searching && page === 0 ? <Spinner /> : null}
          Search
        </button>
      </form>
      <ErrorLine message={error} />
      {photos.length > 0 ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {photos.map((photo) => {
            const isBusy = using === photo.id;
            return (
              <button
                key={photo.id}
                type="button"
                title={`${photo.alt || "Photo"} (${photo.author})`}
                aria-busy={isBusy}
                disabled={using !== null}
                onClick={() => void use(photo)}
                className="group relative aspect-[3/2] overflow-hidden rounded-md border border-border text-left focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait"
                style={{ backgroundColor: photo.color }}
              >
                <img
                  src={photo.thumb}
                  alt={photo.alt}
                  loading="lazy"
                  className={`size-full object-cover ${using !== null && !isBusy ? "opacity-50" : ""}`}
                />
                <span className="absolute inset-x-0 bottom-0 truncate bg-popover/85 px-1.5 py-0.5 text-[11px] text-foreground opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
                  {photo.author}
                </span>
                {isBusy ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-popover/60">
                    <Spinner />
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
      {photos.length > 0 && page < totalPages ? (
        <div>
          <button type="button" className={buttonCls} disabled={searching || using !== null} aria-busy={searching} onClick={() => void load(active, page + 1)}>
            {searching ? <Spinner /> : null}
            More
          </button>
        </div>
      ) : null}
      {active && !searching && photos.length === 0 && !error ? (
        <p className="text-xs text-muted-foreground">No photos found for "{active}".</p>
      ) : null}
    </div>
  );
}

// Storage section: everything the plugin keeps on the bb server (wallpapers, fonts), with sizes and removal.
import { useEffect, useState } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { Assets, FrameState } from "../../shared/contract";
import { ErrorLine, linkButtonCls, messageOf, Section, Spinner, SubHeading, type Commit, type Rpc } from "./primitives";

const formatBytes = (bytes: number) =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
const total = (items: { bytes: number }[]) => items.reduce((sum, i) => sum + i.bytes, 0);

/** One stored asset: preview, name, detail, size, and its remove button. */
function AssetRow({ preview, name, detail, bytes, busy, disabled, onRemove, removeLabel }: {
  preview: React.ReactNode;
  name: string;
  detail: string | null;
  bytes: number;
  busy: boolean;
  disabled: boolean;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <li className="flex min-h-10 items-center gap-3 py-1.5">
      {preview}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{name}</span>
        {detail ? <span className="truncate text-xs text-muted-foreground">{detail}</span> : null}
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(bytes)}</span>
      <button
        type="button"
        aria-label={removeLabel}
        disabled={disabled}
        onClick={onRemove}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
      >
        {busy ? <Spinner /> : <Icon name="Trash2" className="size-4" />}
      </button>
    </li>
  );
}

export function StorageSection({ state, rpc, commit }: { state: FrameState; rpc: Rpc; commit: Commit }) {
  const [assets, setAssets] = useState<Assets | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Re-read whenever anything is saved: a new download or a switch shows up here too.
  useEffect(() => {
    void rpc.call("assets_list", {}).then(setAssets, (e: unknown) => setError(messageOf(e, "Could not read storage.")));
  }, [rpc, state.updatedAt]);

  /** Runs a removal, then refreshes the rest of the settings (the wallpaper or a font may change). */
  const run = async (key: string, work: () => Promise<Assets>) => {
    setBusy(key);
    setError(null);
    try {
      setAssets(await work());
      commit(await rpc.call("frame_get", {}));
    } catch (e) {
      setError(messageOf(e, "Could not remove it."));
    } finally {
      setBusy(null);
    }
  };

  if (!assets) return null;
  const { wallpapers, fonts } = assets;
  const unusedWallpapers = wallpapers.filter((w) => !w.active).length;
  const unusedFonts = fonts.filter((f) => f.usedBy.length === 0).length;

  return (
    <Section
      title="Storage"
      hint={`Downloads and uploads kept on this bb server: ${formatBytes(total(wallpapers) + total(fonts))}. Removing one frees its space.`}
    >
      <div className="flex flex-col gap-1">
        <SubHeading
          title="Wallpapers"
          hint={wallpapers.length ? `${wallpapers.length} · ${formatBytes(total(wallpapers))}` : "none stored"}
          action={unusedWallpapers > 0 ? (
            <button type="button" className={linkButtonCls} disabled={busy !== null}
              onClick={() => void run("prune:wallpaper", () => rpc.call("assets_prune", { kind: "wallpaper" }))}>
              Remove {unusedWallpapers} not in use
            </button>
          ) : null}
        />
        {wallpapers.length > 0 ? (
          <ul className="divide-y divide-border">
            {wallpapers.map((w) => (
              <AssetRow
                key={w.id}
                preview={<span aria-hidden="true" className="h-8 w-12 shrink-0 rounded-md border border-border bg-muted bg-cover bg-center"
                  style={w.thumb ? { backgroundImage: `url("${w.thumb}")` } : undefined} />}
                name={w.credit ? `Photo by ${w.credit.name}` : "Your upload"}
                detail={[w.source === "unsplash" ? "Unsplash" : "Upload", w.active ? "in use" : null].filter(Boolean).join(" · ")}
                bytes={w.bytes}
                busy={busy === w.id}
                disabled={busy !== null}
                removeLabel={w.active ? "Remove the current wallpaper" : "Remove this wallpaper"}
                onRemove={() => void run(w.id, () => rpc.call("asset_remove", { kind: "wallpaper", id: w.id }))}
              />
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <SubHeading
          title="Fonts"
          hint={fonts.length ? `${fonts.length} · ${formatBytes(total(fonts))}` : "none installed"}
          action={unusedFonts > 0 ? (
            <button type="button" className={linkButtonCls} disabled={busy !== null}
              onClick={() => void run("prune:font", () => rpc.call("assets_prune", { kind: "font" }))}>
              Remove {unusedFonts} not in use
            </button>
          ) : null}
        />
        {fonts.length > 0 ? (
          <ul className="divide-y divide-border">
            {fonts.map((f) => (
              <AssetRow
                key={f.family}
                preview={<span aria-hidden="true" className="flex h-8 w-12 shrink-0 items-center justify-center rounded-md border border-border text-sm"
                  style={{ fontFamily: `"${f.family}"` }}>Aa</span>}
                name={f.family}
                detail={f.usedBy.length ? `Used for ${f.usedBy.join(", ")}; removing switches that back to bb's font` : "Not in use"}
                bytes={f.bytes}
                busy={busy === `font:${f.family}`}
                disabled={busy !== null}
                removeLabel={`Remove ${f.family}`}
                onRemove={() => void run(`font:${f.family}`, () => rpc.call("asset_remove", { kind: "font", id: f.family }))}
              />
            ))}
          </ul>
        ) : null}
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}

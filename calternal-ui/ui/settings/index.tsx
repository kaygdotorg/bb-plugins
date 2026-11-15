// The Calternal UI settings screen: loads the state once and composes the sections in order.
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { FrameState, rpcContract } from "../../shared/contract";
import { CHANGED_EVENT } from "../../frame/events";
import { AppearanceSection } from "./appearance";
import { FontsSection } from "./fonts";
import { GlassSection } from "./glass";
import { messageOf, type Commit } from "./primitives";
import { BrandSection } from "./brand";
import { StorageSection } from "./storage";
import { WallpaperSection } from "./wallpaper";

export function FrameSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<FrameState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("frame_get", {}).then(setState, (e: unknown) => setLoadError(messageOf(e, "Could not load settings.")));
  }, [rpc]);

  // After every save: show the new state here, and tell the overlay to re-fetch and restyle bb.
  const commit: Commit = (next) => {
    setState(next);
    window.dispatchEvent(new Event(CHANGED_EVENT));
  };

  if (loadError) return <p className="text-sm text-destructive">{loadError}</p>;
  if (!state) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="flex flex-col gap-10">
      <WallpaperSection state={state} rpc={rpc} commit={commit} />
      <GlassSection state={state} rpc={rpc} commit={commit} />
      <AppearanceSection state={state} rpc={rpc} commit={commit} />
      <FontsSection state={state} rpc={rpc} commit={commit} />
      <BrandSection state={state} rpc={rpc} commit={commit} />
      <StorageSection state={state} rpc={rpc} commit={commit} />
    </div>
  );
}

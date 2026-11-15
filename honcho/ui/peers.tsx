import { useState } from "react";
import { ago } from "./format";
import { useAction, useMemoryRpc, useRemote } from "./data";
import { Button, Empty, Loading, Offline, inputClass } from "./primitives";

function PeerRow({ providerId, peer, firstSeen, onChanged }: { providerId: string; peer: string; firstSeen: number | null; onChanged(): void }) {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(peer);
  const save = () => void run("rename", async () => {
    await rpc.call("peers.rename", { providerId, peer: value.trim() });
    setEditing(false);
    onChanged();
  });
  return (
    <li className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-b-0">
      <span className="w-28 shrink-0 truncate text-xs">{providerId}</span>
      <span aria-hidden="true" className="text-xs text-muted-foreground">→</span>
      {editing ? (
        <form className="flex min-w-0 flex-1 items-center gap-2" onSubmit={(e) => { e.preventDefault(); save(); }}>
          <input aria-label={`peer for ${providerId}`} className={inputClass} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
          <Button type="submit" disabled={busy !== null || !value.trim() || value.trim() === peer}>save</Button>
          <Button variant="ghost" onClick={() => { setEditing(false); setValue(peer); }}>cancel</Button>
        </form>
      ) : (
        <>
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{peer}</span>
          <span className="shrink-0 text-2xs text-muted-foreground">{firstSeen ? `first seen ${ago(firstSeen)}` : "not seen yet"}</span>
          <Button variant="ghost" className="h-6 px-1.5" onClick={() => setEditing(true)}>rename</Button>
        </>
      )}
      {error ? <span className="text-2xs text-destructive">{error}</span> : null}
    </li>
  );
}

export function PeersTab() {
  const peers = useRemote("peers.list", {});
  return (
    <div className="space-y-2">
      <p className="text-2xs text-muted-foreground">each harness writes as its own ai peer. honcho can't rename or delete peers, so a rename starts a new peer from now on; the old one keeps what it already has.</p>
      {peers.data === null ? (
        peers.error ? <Offline message={peers.error} onRetry={() => void peers.refetch()} /> : <Loading what="peers" />
      ) : peers.data.length === 0 ? (
        <Empty title="no peers yet">a harness gets its peer the first time it is used.</Empty>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card" aria-label="peers">
          {peers.data.map((p) => <PeerRow key={p.providerId} {...p} onChanged={() => void peers.refetch()} />)}
        </ul>
      )}
    </div>
  );
}

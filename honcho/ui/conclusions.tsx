import { useState } from "react";
import type { ConclusionView } from "../lib/contract";
import { ago, plural } from "./format";
import { useAction, useMemoryRpc, useRemote } from "./data";
import { Badge, Button, Empty, Loading, Offline, StaleNote, inputClass } from "./primitives";

function Item({ c, onChanged }: { c: ConclusionView; onChanged(): void }) {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="space-y-1 border-b border-border px-3 py-2 last:border-b-0">
      <p className="text-xs leading-relaxed">{c.content}</p>
      <div className="flex items-center gap-2">
        {c.confirmed ? <Badge tone="good">confirmed</Badge> : c.agentWritten ? <Badge tone="warn" title="saved by an agent, not reviewed">agent-written</Badge> : <Badge>derived</Badge>}
        <span className="text-2xs text-muted-foreground">{ago(Date.parse(c.created_at))}</span>
        <span className="flex-1" />
        {error ? <span className="text-2xs text-destructive">{error}</span> : null}
        {!c.confirmed ? (
          <Button variant="ghost" className="h-6 px-1.5" disabled={busy !== null} onClick={() => void run("confirm", async () => { await rpc.call("conclusions.confirm", { id: c.id }); onChanged(); })}>confirm</Button>
        ) : null}
        {confirming ? (
          <>
            <Button variant="danger" className="h-6 px-1.5" disabled={busy !== null} onClick={() => void run("delete", async () => { await rpc.call("conclusions.delete", { id: c.id }); setConfirming(false); onChanged(); })}>delete for good</Button>
            <Button variant="ghost" className="h-6 px-1.5" onClick={() => setConfirming(false)}>keep</Button>
          </>
        ) : (
          <Button variant="ghost" className="h-6 px-1.5" onClick={() => setConfirming(true)}>delete</Button>
        )}
      </div>
    </li>
  );
}

export function ConclusionsTab() {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const list = useRemote("conclusions.list", { ...(query ? { query } : {}), limit: 50 });
  return (
    <div className="space-y-2">
      <form className="flex gap-2" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); }}>
        <input aria-label="search conclusions" className={inputClass} placeholder="search what honcho believes" value={draft} onChange={(e) => setDraft(e.target.value)} />
        <Button type="submit">search</Button>
      </form>
      <StaleNote error={list.data ? list.error : null} />
      {list.data === null ? (
        list.error ? <Offline message={list.error} onRetry={() => void list.refetch()} /> : <Loading what="conclusions" />
      ) : list.data.length === 0 ? (
        <Empty title={query ? "no matches" : "no conclusions yet"}>{query ? "try a different phrase." : "honcho derives them as threads are captured."}</Empty>
      ) : (
        <>
          <p className="text-2xs text-muted-foreground">{plural(list.data.length, "conclusion")}{query ? ` for "${query}"` : ""}. agent-written ones stay out of the way until you confirm them.</p>
          <ul className="overflow-hidden rounded-lg border border-border bg-card" aria-label="conclusions">
            {list.data.map((c) => <Item key={c.id} c={c} onChanged={() => void list.refetch()} />)}
          </ul>
        </>
      )}
    </div>
  );
}

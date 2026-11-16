import { useState } from "react";
import type { ConclusionView } from "../lib/contract";
import { ORIGIN_WORDS, ago, originOf, plural, splitMatches } from "./format";
import { useAction, useMemoryRpc, useRemote } from "./data";
import { Badge, Button, Empty, Loading, Offline, StaleNote, inputClass } from "./primitives";

function Item({ c, onChanged }: { c: ConclusionView; onChanged(): void }) {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const [confirming, setConfirming] = useState(false);
  const origin = originOf(c);
  return (
    <li className="space-y-1 border-b border-border px-3 py-2 last:border-b-0">
      <p className="text-xs leading-relaxed">{c.content}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={origin === "confirmed" ? "good" : origin === "agent" ? "warn" : "neutral"} title={ORIGIN_WORDS[origin].hint}>{ORIGIN_WORDS[origin].label}</Badge>
        <span className="text-2xs text-muted-foreground">{ago(Date.parse(c.created_at))}</span>
        <span className="flex-1" />
        {error ? <span className="text-2xs text-destructive">{error}</span> : null}
        {origin !== "confirmed" ? (
          <Button variant="ghost" className="h-6 px-1.5" title="say this is right, so memory trusts it more" disabled={busy !== null} onClick={() => void run("confirm", async () => { await rpc.call("conclusions.confirm", { id: c.id }); onChanged(); })}>confirm</Button>
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

/** How many things came back, in words. Never claims more than matched. */
export function resultsHeader(total: number, exact: number, query: string): string {
  if (!query) return `${total >= LIST_LIMIT ? `the newest ${total}` : plural(total, "thing")} memory has learned`;
  if (exact === 0) return `nothing says "${query}" exactly. ${plural(total, "related thing")}`;
  const related = total - exact;
  return `${plural(exact, "thing")} match${exact === 1 ? "es" : ""} "${query}"${related > 0 ? `, plus ${related} related` : ""}`;
}

const LIST_LIMIT = 50;

export function ConclusionsTab() {
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const list = useRemote("conclusions.list", { ...(query ? { query } : {}), limit: LIST_LIMIT });
  const { exact, related } = splitMatches(list.data ?? [], query);
  const ordered = [...exact, ...related];
  const clear = () => { setDraft(""); setQuery(""); };
  return (
    <div className="space-y-2">
      <form className="flex flex-wrap gap-2" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(draft.trim()); }}>
        <input
          aria-label="search what memory has learned"
          className={`${inputClass} min-w-0 flex-1`}
          placeholder="search what memory has learned"
          value={draft}
          // A new search replaces the old text: focusing selects it all, so typing never appends.
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => { if (e.key === "Escape") clear(); }}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit">search</Button>
        {draft || query ? <Button variant="ghost" aria-label="clear the search" onClick={clear}>clear</Button> : null}
      </form>
      <StaleNote error={list.data ? list.error : null} />
      {list.data === null ? (
        list.error ? <Offline message={list.error} onRetry={() => void list.refetch()} /> : <Loading what="what memory has learned" />
      ) : list.data.length === 0 ? (
        <Empty title={query ? "no matches" : "nothing learned yet"}>{query ? "try a different phrase." : "memory learns from your chats as they are saved."}</Empty>
      ) : (
        <>
          <p className="text-2xs text-muted-foreground">{resultsHeader(ordered.length, exact.length, query)}. confirm means "this is right", so memory trusts it more. delete removes it for good.</p>
          <ul className="overflow-hidden rounded-lg border border-border bg-card" aria-label="things memory has learned">
            {ordered.map((c) => <Item key={c.id} c={c} onChanged={() => void list.refetch()} />)}
          </ul>
        </>
      )}
    </div>
  );
}

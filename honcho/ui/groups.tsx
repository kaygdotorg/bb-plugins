import { useState } from "react";
import type { ForgetGroupPlan } from "../lib/contract";
import { useAction, useMemoryRpc, useRemote } from "./data";
import { ThreadLink } from "./links";
import { Button, Card, Empty, inputClass, Loading, Offline, Section } from "./primitives";

function GroupBody({ group, back }: { group: string; back(): void }) {
  const rpc = useMemoryRpc();
  const state = useRemote("groups.get", { group }, { pollMs: 0, live: false });
  const action = useAction();
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [matches, setMatches] = useState<Array<{ content: string; sessionId: string; date: string }> | null>(null);
  const [plan, setPlan] = useState<ForgetGroupPlan | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [deleted, setDeleted] = useState(false);
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center gap-2"><Button onClick={back}>All groups</Button><h2 className="min-w-0 break-words text-sm font-medium">{group}</h2>
      {state.data ? <Button disabled={!!action.busy} onClick={() => void action.run("pause", async () => { await rpc.call("groups.pause", { group, paused: !state.data!.paused }); await state.refetch(); })}>{state.data.paused ? "Resume this group" : "Pause this group"}</Button> : null}
    </div>
    {state.data ? <>
      <Section title="What memory knows here"><Card className="whitespace-pre-wrap break-words p-3 text-xs">{state.data.summary || "Memory has no summary for this group yet."}</Card></Section>
      <Section title="Search or ask this group"><Card className="space-y-3 p-3"><form className="space-y-2" onSubmit={e => { e.preventDefault(); void action.run("search", async () => { setAnswer(null); setMatches(await rpc.call("groups.search", { group, query })); }); }}>
        <label className="block text-xs">Search or question<input required maxLength={2000} className={inputClass} value={query} onChange={e => setQuery(e.target.value)} /></label>
        <div className="flex gap-2"><Button type="submit" disabled={!!action.busy || !query.trim()}>Search</Button><Button disabled={!!action.busy || !query.trim()} onClick={() => void action.run("ask", async () => { setMatches(null); setAnswer((await rpc.call("groups.ask", { group, query })).content || "No answer available yet."); })}>Ask memory</Button></div>
      </form>
        {answer ? <p className="whitespace-pre-wrap break-words text-xs">{answer}</p> : null}
        {matches ? matches.length ? <ul className="space-y-3">{matches.map((m, i) => <li key={i} className="space-y-1"><p className="whitespace-pre-wrap break-words text-xs">{m.content}</p><ThreadLink id={m.sessionId} title={state.data?.chats.find(c => c.id === m.sessionId)?.title ?? null} /><span className="ml-2 text-xs text-muted-foreground">{new Date(m.date).toLocaleDateString()}</span></li>)}</ul> : <p className="text-xs">No matches in this group.</p> : null}
      </Card></Section>
      <Section title="Chats">{state.data.chats.length ? <ul className="space-y-1">{state.data.chats.map(c => <li key={c.id} className="flex items-center justify-between gap-2"><ThreadLink id={c.id} title={c.title} /><span className="shrink-0 text-xs text-muted-foreground">{new Date(c.lastActivity).toLocaleDateString()}</span></li>)}</ul> : <Empty title="No chats in this group" />}</Section>
    </> : state.error ? <Offline message={state.error} onRetry={() => void state.refetch()} /> : <Loading what="group memory" />}
    <Section title="Forget this group"><Card className="space-y-3 p-3">
      <p className="text-xs text-muted-foreground">Permanently removes the group’s chats from Honcho and conclusions learned from them. BB chats stay in place. The group stays paused afterward. Honcho finishes session cleanup in the background, and its summary may take time to update.</p>
      {deleted ? <p role="status" className="text-xs">Deletion requested. This group remains paused.</p> : plan ? <div className="space-y-2">
        <p role="status" className="text-xs">{plan.sessions} chats · {plan.messages} messages · {plan.conclusions} conclusions. This cannot be undone.</p>
        <label className="block space-y-1 text-xs">Type {group} to confirm<input className={inputClass} value={confirmation} onChange={e => setConfirmation(e.target.value)} autoComplete="off" /></label>
        <Button variant="danger" disabled={!!action.busy || confirmation !== group} onClick={() => void action.run("forget", async () => {
          const token = plan.token; setPlan(null); setConfirmation("");
          await rpc.call("groups.forget", { group, confirmation, token }); setDeleted(true); await state.refetch();
        })}>Forget permanently</Button>
        <Button variant="ghost" onClick={() => { setPlan(null); setConfirmation(""); }}>Cancel</Button>
      </div> : <Button disabled={!!action.busy} onClick={() => void action.run("preview", async () => setPlan(await rpc.call("groups.forgetPreview", { group })))}>Check what would be removed</Button>}
    </Card></Section>
    {action.error ? <p role="alert" className="text-xs text-destructive">{action.error}</p> : null}
  </div>;
}

export function GroupsTab() {
  const [selected, setSelected] = useState<string | null>(null);
  const state = useRemote("groups.list", {}, { enabled: !selected, pollMs: 0, live: false });
  if (selected) return <GroupBody key={selected} group={selected} back={() => { setSelected(null); void state.refetch(); }} />;
  if (!state.data) return state.error ? <Offline message={state.error} onRetry={() => void state.refetch()} /> : <Loading what="groups" />;
  return <Section title="Groups" hint="A group keeps memory together for a repository or project.">
    {state.data.length ? <ul className="space-y-2">{state.data.map(g => <li key={g.id}><button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-left hover:bg-muted" onClick={() => setSelected(g.id)}>
      <span className="min-w-0 break-words text-sm font-medium">{g.id}</span><span className="text-xs text-muted-foreground">{g.chats} {g.chats === 1 ? "chat" : "chats"} · {g.paused ? "Paused" : "Active"}{g.lastActivity ? ` · ${new Date(g.lastActivity).toLocaleDateString()}` : ""}</span>
    </button></li>)}</ul> : <Empty title="No groups yet">Groups appear as chats are saved.</Empty>}
  </Section>;
}

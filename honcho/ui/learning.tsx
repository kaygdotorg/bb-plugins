import { useAction, useMemoryRpc, useRemote } from "./data";
import { Button, Card, Section } from "./primitives";

export function LearningStatus() {
  const state = useRemote("learning.get", {}, { pollMs: 60_000, live: false });
  const rpc = useMemoryRpc();
  const action = useAction();
  const s = state.data;
  return <Section title="Learning"><Card className="space-y-2 p-3">
    <p className="text-xs">{s ? s.pending + s.inProgress > 0 ? `Still learning · ${s.pending + s.inProgress} tasks remaining` : "Memory is up to date" : state.error ? "Learning status is unavailable" : "Checking learning status…"}</p>
    {s?.lastRun ? <p className="text-xs text-muted-foreground">Last consolidation: {new Date(s.lastRun.at).toLocaleString()} · {s.lastRun.status}</p> : <p className="text-xs text-muted-foreground">No consolidation recorded yet.</p>}
    <p className="text-xs text-muted-foreground">Consolidation combines related conclusions into longer-term memory.</p>
    <Button disabled={!!action.busy || !s} onClick={() => void action.run("consolidate", async () => { await rpc.call("learning.consolidate", {}); await state.refetch(); })}>Consolidate now</Button>
    {action.error ? <p role="alert" className="text-xs text-destructive">{action.error}</p> : null}
  </Card></Section>;
}

export function ChatSummary({ threadId }: { threadId: string }) {
  const s = useRemote("thread.summary", { threadId }, { pollMs: 60_000, live: false });
  return <details className="text-xs"><summary className="cursor-pointer text-muted-foreground">This chat so far</summary><p className="mt-2 whitespace-pre-wrap break-words">{s.data?.content ?? (s.error ? "The chat summary is unavailable." : s.loading ? "Loading summary…" : "No summary yet. It appears after Honcho processes this chat.")}</p></details>;
}

import type { ExperimentalThreadContextCardProps, ExperimentalThreadContextSegmentProps } from "@get-bb/plugin-sdk/app";
import { experimental_Icon as Icon, experimental_ThreadContextCardRow as CardRow, experimental_useThreadContextKind, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ConclusionView } from "../lib/contract";
import { useMemoryRpc, useNow, useRemote } from "./data";
import { statusLine } from "./format";
import { Badge } from "./primitives";

export const MEMORY_PATH = "memory";

function useThreadMemory(threadId: string) {
  const rpc = useMemoryRpc();
  const remote = useRemote("thread.status", { threadId }, { pollMs: 15_000 });
  const now = useNow();
  const status = remote.data;
  const toggle = async () => {
    if (!status || status.state === "not-captured") return;
    await rpc.call("pause.set", { kind: "thread", id: threadId, paused: status.state !== "paused" });
    await remote.refetch();
  };
  const line = status ? statusLine(status, status.queued, now) : remote.error ? "memory · offline" : null;
  const clickable = status !== null && status.state !== "not-captured";
  const title = status
    ? status.state === "not-captured"
      ? status.reason ?? "this thread isn't being captured"
      : status.state === "paused"
        ? "click to resume saving this thread"
        : `click to pause memory for this thread${status.reason ? `. ${status.reason}` : ""}`
    : remote.error ?? undefined;
  return { line, clickable, title, toggle, status };
}

/** The card row. The same status shows as a context segment when the pane has no card. */
export function ThreadStatusRow({ threadId }: ExperimentalThreadContextCardProps) {
  const m = useThreadMemory(threadId);
  if (m.line === null) return null;
  return <CardRow icon="Brain" label={m.line} title={m.title} onClick={m.clickable ? () => void m.toggle() : undefined} />;
}

export function ThreadStatusSegment({ threadId }: ExperimentalThreadContextSegmentProps) {
  const m = useThreadMemory(threadId);
  if (m.line === null) return null;
  return (
    <button
      type="button"
      title={m.title}
      disabled={!m.clickable}
      onClick={() => void m.toggle()}
      className="flex h-6 items-center gap-1.5 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:pointer-events-none"
    >
      <Icon name="Brain" aria-hidden="true" className="size-3.5" />
      <span>{m.line}</span>
    </button>
  );
}

/** Hide the segment while the pane shows the card (which carries the same status). */
export function useSegmentVisible(): boolean {
  return experimental_useThreadContextKind() === "banner";
}

function Line({ c }: { c: ConclusionView }) {
  return (
    <li className="flex items-start gap-1.5">
      <span className="line-clamp-2 min-w-0 flex-1 text-xs leading-snug" title={c.content}>{c.content}</span>
      {c.agentWritten && !c.confirmed ? <Badge tone="warn" title="saved by an agent, not reviewed">agent</Badge> : null}
    </li>
  );
}

function Group({ title, items }: { title: string; items: ConclusionView[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-2xs text-muted-foreground">{title}</p>
      <ul className="space-y-1" aria-label={title}>{items.slice(0, 3).map((c) => <Line key={c.id} c={c} />)}</ul>
    </div>
  );
}

export function ThreadMemorySection({ threadId }: ExperimentalThreadContextCardProps) {
  const nav = useBbNavigate();
  const ctx = useRemote("thread.context", { threadId }, { pollMs: 60_000 });
  const open = (
    <button type="button" onClick={() => nav.toPluginPanel(MEMORY_PATH)} className="text-2xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">open memory</button>
  );
  if (ctx.data === null) {
    if (ctx.loading) return <p role="status" className="text-2xs text-muted-foreground">loading memory…</p>;
    return <div className="space-y-1"><p className="text-2xs text-muted-foreground">memory is offline.</p>{open}</div>;
  }
  const { top, fromThread, stale, scope } = ctx.data;
  const offline = stale || ctx.error !== null;
  return (
    <div className="space-y-2">
      {offline ? <p className="text-2xs text-warning" title="honcho is unreachable; this is the last memory we had">stale · showing the last known memory</p> : null}
      <Group title={scope ? `about ${scope}` : "what honcho knows"} items={top} />
      <Group title="from this thread" items={fromThread} />
      {top.length === 0 && fromThread.length === 0 ? <p className="text-xs text-muted-foreground">nothing learned here yet.</p> : null}
      {open}
    </div>
  );
}

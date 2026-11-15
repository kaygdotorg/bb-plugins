import type { ExperimentalThreadContextCardProps, ExperimentalThreadContextSegmentProps, ExperimentalThreadInfoProps } from "@get-bb/plugin-sdk/app";
import { experimental_DetailRow as DetailRow, experimental_Icon as Icon, experimental_ThreadContextCardRow as CardRow, experimental_useThreadContextKind, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ConclusionView } from "../lib/contract";
import { useMemoryRpc, useNow, useRemote } from "./data";
import { ORIGIN_WORDS, STATUS_LOADING, originOf, statusLine } from "./format";
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
  // Never null: the control stays on screen while the first answer is slow or missing.
  const line = status ? statusLine(status, status.queued, now) : remote.error ? "memory · offline" : STATUS_LOADING;
  const clickable = status !== null && status.state !== "not-captured";
  const title = status
    ? status.state === "not-captured"
      ? status.reason ?? "memory isn't saving this chat"
      : status.state === "paused"
        ? "memory is paused for this chat. click to start saving it again"
        : `click to stop saving this chat to memory${status.reason ? `. ${status.reason}` : ""}`
    : remote.error ?? "checking whether memory is saving this chat";
  return { line, clickable, title, toggle, status };
}

/** The card row. The same status shows as a context segment when the pane has no card. */
export function ThreadStatusRow({ threadId }: ExperimentalThreadContextCardProps) {
  const m = useThreadMemory(threadId);
  return <CardRow icon="Brain" label={m.line} title={m.title} onClick={m.clickable ? () => void m.toggle() : undefined} />;
}

/** The Info tab row: renders wherever the right panel does, even when a theme hides the composer's context strip. */
export function ThreadInfoStatusRow({ threadId }: ExperimentalThreadInfoProps) {
  const m = useThreadMemory(threadId);
  const nav = useBbNavigate();
  const link = "text-xs underline-offset-2 hover:underline disabled:cursor-default disabled:no-underline";
  return (
    <DetailRow icon="Brain" label="Memory">
      <span className="flex min-w-0 flex-wrap items-center gap-x-2">
        <button type="button" title={m.title} aria-label={`${m.line}. ${m.title}`} disabled={!m.clickable} onClick={() => void m.toggle()} className={link}>{m.line}</button>
        <button type="button" onClick={() => nav.toPluginPanel(MEMORY_PATH)} className={`${link} text-muted-foreground hover:text-foreground`}>open memory</button>
      </span>
    </DetailRow>
  );
}

export function ThreadStatusSegment({ threadId }: ExperimentalThreadContextSegmentProps) {
  const m = useThreadMemory(threadId);
  return (
    <button
      type="button"
      title={m.title}
      aria-label={`${m.line}. ${m.title}`}
      disabled={!m.clickable}
      onClick={() => void m.toggle()}
      className="flex h-6 shrink-0 items-center gap-1.5 rounded px-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
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
  const origin = originOf(c);
  return (
    <li className="flex items-start gap-1.5">
      <span className="line-clamp-2 min-w-0 flex-1 text-xs leading-snug" title={c.content}>{c.content}</span>
      {origin === "confirmed" ? null : <Badge tone={origin === "agent" ? "warn" : "neutral"} title={ORIGIN_WORDS[origin].hint}>{ORIGIN_WORDS[origin].label}</Badge>}
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
    return <div className="space-y-1"><p className="text-2xs text-muted-foreground">memory can't be reached right now.</p>{open}</div>;
  }
  const { top, fromThread, stale, scope } = ctx.data;
  const offline = stale || ctx.error !== null;
  return (
    <div className="space-y-2">
      {offline ? <p className="text-2xs text-warning" title="memory can't be reached, so this is what it had last time">out of date · showing what memory last knew</p> : null}
      <Group title={scope ? `what memory has learned about ${scope}` : "what memory has learned"} items={top} />
      <Group title="from this chat" items={fromThread} />
      {top.length === 0 && fromThread.length === 0 ? <p className="text-xs text-muted-foreground">memory hasn't learned anything here yet.</p> : null}
      {open}
    </div>
  );
}

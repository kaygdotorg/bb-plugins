import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk/app";
import { experimental_Icon as Icon, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import type { MemoryInjection } from "../lib/contract";
import { useMemoryRpc, type Rpc } from "./data";
import { ThreadLink } from "./links";

const MEMORY_PATH = "memory";
/** How long after a message a turn injection can still be its own. */
export const TURN_WINDOW_MS = 120_000;
/** A session injection may be stamped a little after the message that triggered the rebuild. */
export const SESSION_LEAD_MS = 5_000;
const POLL_MS = 60_000;

interface UserMessage { id: string; createdAt: number }

/** Which user messages (by id) each injection belongs to, given every user message known so far. */
export function ownersOf(injection: MemoryInjection, users: readonly UserMessage[]): UserMessage | null {
  if (injection.kind === "turn") {
    let best: UserMessage | null = null;
    for (const u of users) {
      if (u.createdAt > injection.at) continue;
      if (best === null || u.createdAt > best.createdAt || (u.createdAt === best.createdAt && u.id < best.id)) best = u;
    }
    return best !== null && injection.at - best.createdAt <= TURN_WINDOW_MS ? best : null;
  }
  let best: UserMessage | null = null;
  for (const u of users) {
    if (u.createdAt < injection.at - SESSION_LEAD_MS) continue;
    if (best === null || u.createdAt < best.createdAt || (u.createdAt === best.createdAt && u.id < best.id)) best = u;
  }
  return best !== null && best.createdAt - injection.at <= TURN_WINDOW_MS ? best : null;
}

// One store per thread, shared by every message row, so fifty messages make one request. An entry
// lives while at least one row is mounted.
interface Entry {
  data: MemoryInjection[] | null;
  users: Map<string, number>;
  rev: number;
  subs: Set<() => void>;
  rpc: Rpc | null;
  threadId: string;
  inflight: boolean;
  again: boolean;
  scheduled: boolean;
  timer: number | null;
  closed: boolean;
}
const entries = new Map<string, Entry>();

const bump = (e: Entry) => { e.rev++; for (const s of [...e.subs]) s(); };

async function load(e: Entry): Promise<void> {
  if (e.closed || !e.rpc) return;
  if (e.inflight) { e.again = true; return; }
  e.inflight = true;
  try {
    do {
      e.again = false;
      try {
        const value = await (e.rpc.call as (m: string, i: unknown) => Promise<MemoryInjection[]>)("recall.injections", { threadId: e.threadId });
        if (e.closed) return;
        if (e.data === null || JSON.stringify(e.data) !== JSON.stringify(value)) { e.data = value; bump(e); }
      } catch { /* keep what we had; the next signal retries */ }
    } while (e.again && !e.closed);
  } finally { e.inflight = false; }
}

/** Coalesce the burst of signals every mounted row hears into one request. */
function schedule(e: Entry) {
  if (e.scheduled || e.closed) return;
  e.scheduled = true;
  setTimeout(() => { e.scheduled = false; void load(e); }, 30);
}

function acquire(threadId: string, onChange: () => void): () => void {
  let e = entries.get(threadId);
  if (!e) {
    e = { data: null, users: new Map(), rev: 0, subs: new Set(), rpc: null, threadId, inflight: false, again: false, scheduled: false, timer: null, closed: false };
    entries.set(threadId, e);
  }
  e.subs.add(onChange);
  const entry = e;
  if (entry.timer === null) entry.timer = window.setInterval(() => void load(entry), POLL_MS);
  queueMicrotask(() => { if (entry.data === null) schedule(entry); });
  return () => {
    entry.subs.delete(onChange);
    if (entry.subs.size > 0) return;
    entry.closed = true;
    if (entry.timer !== null) window.clearInterval(entry.timer);
    if (entries.get(threadId) === entry) entries.delete(threadId);
  };
}

function useInjections(threadId: string, message: UserMessage) {
  const rpc = useMemoryRpc();
  const subscribeRef = useRef<{ id: string; fn: (cb: () => void) => () => void } | null>(null);
  if (subscribeRef.current?.id !== threadId) subscribeRef.current = { id: threadId, fn: (cb) => acquire(threadId, cb) };
  // The rpc caller is only read inside load(), through the entry.
  const entry = entries.get(threadId);
  if (entry) entry.rpc = rpc;
  const rev = useSyncExternalStore(subscribeRef.current.fn, () => entries.get(threadId)?.rev ?? 0, () => 0);
  void rev;
  useEffect(() => {
    const e = entries.get(threadId);
    if (!e) return;
    e.rpc = rpc;
    if (e.users.get(message.id) !== message.createdAt) { e.users.set(message.id, message.createdAt); bump(e); }
    schedule(e);
    return () => {
      if (e.closed) return;
      if (e.users.delete(message.id)) bump(e);
    };
  }, [threadId, message.id, message.createdAt, rpc]);
  useRealtime("changed", () => { const e = entries.get(threadId); if (e) schedule(e); });
  useRealtime("activity", () => { const e = entries.get(threadId); if (e) schedule(e); });
  const e = entries.get(threadId);
  const users = new Map(e?.users);
  users.set(message.id, message.createdAt);
  return { injections: e?.data ?? [], users: [...users].map(([id, createdAt]) => ({ id, createdAt })) };
}

export function chipLabel(i: MemoryInjection): string {
  const scope = i.scope ?? "none";
  return i.kind === "session"
    ? `from honcho · session memory · scope ${scope}`
    : `from honcho · ${i.items.length === 1 ? "1 memory" : `${i.items.length} memories`} · scope ${scope}`;
}

function Chip({ injection }: { injection: MemoryInjection }) {
  const [open, setOpen] = useState(false);
  const nav = useBbNavigate();
  const label = chipLabel(injection);
  const card = injection.card ?? [];
  return (
    <div className="my-1 max-w-full text-xs text-muted-foreground">
      <button
        type="button"
        aria-expanded={open}
        title={open ? "hide what memory added" : "show what memory added"}
        onClick={() => setOpen((v) => !v)}
        className="flex h-5 max-w-full items-center gap-1.5 rounded px-1 text-2xs hover:bg-muted hover:text-foreground"
      >
        <Icon name="Brain" aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {open ? (
        <div className="mt-1 space-y-2 rounded-md border border-border/60 px-2 py-1.5">
          {card.length > 0 ? (
            <ul aria-label="session card" className="space-y-0.5">
              {card.map((line, n) => <li key={n} className="text-xs leading-snug text-foreground">{line}</li>)}
            </ul>
          ) : null}
          {injection.items.length > 0 ? (
            <ul aria-label="memories" className="space-y-1.5">
              {injection.items.map((item, n) => (
                <li key={n} className="space-y-0.5">
                  <p className="text-xs leading-snug text-foreground">{item.content}</p>
                  <p className="flex min-w-0 items-center gap-1.5 text-2xs">
                    {item.date ? <span>{item.date}</span> : null}
                    {item.sourceThreadId ? <ThreadLink id={item.sourceThreadId} title={item.sourceTitle} /> : <span>{item.sourceTitle ?? "untitled chat"}</span>}
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          <button type="button" onClick={() => nav.toPluginPanel(MEMORY_PATH)} className="text-2xs underline-offset-2 hover:text-foreground hover:underline">open memory</button>
        </div>
      ) : null}
    </div>
  );
}

export function FromHoncho({ message }: ExperimentalMessageMetadataProps) {
  const isUser = message.role === "user";
  return isUser ? <Matched threadId={message.threadId} message={{ id: message.id, createdAt: message.createdAt }} /> : null;
}

function Matched({ threadId, message }: { threadId: string; message: UserMessage }) {
  const { injections, users } = useInjections(threadId, message);
  const mine = injections.filter((i) => ownersOf(i, users)?.id === message.id);
  if (mine.length === 0) return null;
  return <>{mine.map((i, n) => <Chip key={`${i.kind}:${i.at}:${n}`} injection={i} />)}</>;
}

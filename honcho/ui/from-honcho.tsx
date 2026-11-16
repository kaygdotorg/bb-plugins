import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ExperimentalMessageMetadataProps } from "@get-bb/plugin-sdk/app";
import { experimental_Icon as Icon, useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import type { MemoryInjection } from "../lib/contract";
import { useMemoryRpc, type Rpc } from "./data";
import { GROUP_HINT } from "./format";
import { ThreadLink } from "./links";

const MEMORY_PATH = "memory";
/** How long after a message a turn injection can still be its own. */
export const TURN_WINDOW_MS = 120_000;
/** A session injection may be stamped a little after the message that triggered the rebuild. */
export const SESSION_LEAD_MS = 5_000;
const POLL_MS = 60_000;

interface UserMessage { id: string; createdAt: number; turnId?: string | null }
interface Known extends UserMessage { role: "user" | "assistant" }

/** The first assistant message of the user message's turn: turnId equality first, else the time window up to the next user message. */
export function firstReplyOf(user: UserMessage, users: readonly UserMessage[], assistants: readonly UserMessage[]): UserMessage | null {
  const first = (list: readonly UserMessage[]) => list.reduce<UserMessage | null>((b, m) => (b === null || m.createdAt < b.createdAt || (m.createdAt === b.createdAt && m.id < b.id) ? m : b), null);
  if (user.turnId) {
    const same = first(assistants.filter((m) => m.turnId === user.turnId));
    if (same) return same;
  }
  let next = Infinity;
  for (const u of users) if (u.id !== user.id && u.createdAt > user.createdAt && u.createdAt < next) next = u.createdAt;
  return first(assistants.filter((m) => m.createdAt >= user.createdAt && m.createdAt < next && !(user.turnId && m.turnId && m.turnId !== user.turnId)));
}

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
  msgs: Map<string, Known>;
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
    e = { data: null, msgs: new Map(), rev: 0, subs: new Set(), rpc: null, threadId, inflight: false, again: false, scheduled: false, timer: null, closed: false };
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

function useInjections(threadId: string, message: Known) {
  const rpc = useMemoryRpc();
  const subscribeRef = useRef<{ id: string; fn: (cb: () => void) => () => void } | null>(null);
  if (subscribeRef.current?.id !== threadId) subscribeRef.current = { id: threadId, fn: (cb) => acquire(threadId, cb) };
  // The rpc caller is only read inside load(), through the entry.
  const entry = entries.get(threadId);
  if (entry) entry.rpc = rpc;
  const rev = useSyncExternalStore(subscribeRef.current.fn, () => entries.get(threadId)?.rev ?? 0, () => 0);
  void rev;
  const turnId = message.turnId ?? null;
  useEffect(() => {
    const e = entries.get(threadId);
    if (!e) return;
    e.rpc = rpc;
    const known = e.msgs.get(message.id);
    if (!known || known.createdAt !== message.createdAt || (known.turnId ?? null) !== turnId || known.role !== message.role) {
      e.msgs.set(message.id, { id: message.id, createdAt: message.createdAt, turnId, role: message.role });
      bump(e);
    }
    schedule(e);
    return () => {
      if (e.closed) return;
      if (e.msgs.delete(message.id)) bump(e);
    };
  }, [threadId, message.id, message.createdAt, message.role, turnId, rpc]);
  useRealtime("changed", () => { const e = entries.get(threadId); if (e) schedule(e); });
  useRealtime("activity", () => { const e = entries.get(threadId); if (e) schedule(e); });
  const e = entries.get(threadId);
  const all = new Map(e?.msgs);
  all.set(message.id, { id: message.id, createdAt: message.createdAt, turnId, role: message.role });
  const list = [...all.values()];
  return { injections: e?.data ?? [], users: list.filter((m) => m.role === "user"), assistants: list.filter((m) => m.role === "assistant") };
}

export interface TurnMemory { session: MemoryInjection[]; turn: MemoryInjection[] }

/** Collapsed line, worded like bb's tool rows ("Ran 3 commands"): no internal terms. */
export function chipLabel({ turn }: TurnMemory): string {
  const count = turn.reduce((n, i) => n + i.items.length, 0);
  if (count === 0) return "Used memory";
  return count === 1 ? "Recalled 1 memory" : `Recalled ${count} memories`;
}

/** The quiet footnote under the expanded body: where the memory came from. */
export function chipSource({ session, turn }: TurnMemory): string {
  const scope = (turn.length > 0 ? turn[0]!.scope : session[0]?.scope) ?? null;
  const kinds = [...(session.length > 0 ? ["background memory"] : []), ...(turn.length > 0 ? ["this message"] : [])];
  return ["Honcho", ...(scope ? [`group ${scope}`] : []), kinds.join(" + ")].filter(Boolean).join(" · ");
}

function Chip({ memory }: { memory: TurnMemory }) {
  const [open, setOpen] = useState(false);
  const nav = useBbNavigate();
  const label = chipLabel(memory);
  const card = memory.session.flatMap((i) => i.card ?? []);
  const items = memory.turn.flatMap((i) => i.items);
  // Matches bb's own timeline rows (tool rows, "Thought", "Message from"): same type scale, ink and rhythm.
  const sub = "text-xs text-muted-foreground";
  return (
    <div data-honcho-memory="" className="max-w-full">
      <button
        type="button"
        aria-expanded={open}
        title={open ? "hide what memory added" : "show what memory added"}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full max-w-full items-center justify-start gap-1 px-0 py-0 text-left text-sm leading-5 text-muted-foreground [overflow-wrap:anywhere] hover:text-foreground"
      >
        <Icon name="Brain" aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 break-words">{label}</span>
        <Icon name="ChevronRight" aria-hidden="true" className={`size-3.5 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
      </button>
      {open ? (
        <div data-honcho-memory-body="" className="ml-2 mt-1 space-y-3 border-l border-border pl-3 text-sm leading-relaxed text-muted-foreground">
          {card.length > 0 ? (
            <div className="space-y-1">
              <p className={sub}>session memory</p>
              <ul aria-label="session card" className="space-y-1">
                {card.map((line, n) => <li key={n} className="break-words">{line}</li>)}
              </ul>
            </div>
          ) : null}
          {items.length > 0 ? (
            <div className="space-y-1">
              <p className={sub}>this turn</p>
              <ul aria-label="memories" className="space-y-2">
                {items.map((item, n) => (
                  <li key={n}>
                    <p className="break-words">{item.content}</p>
                    <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs">
                      {item.date ? <span>{item.date}</span> : null}
                      {item.sourceThreadId ? <ThreadLink id={item.sourceThreadId} title={item.sourceTitle} /> : <span>{item.sourceTitle ?? "untitled chat"}</span>}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <p className="flex flex-wrap items-center gap-x-1.5 text-[13px] leading-5 text-subtle-foreground" title={GROUP_HINT}>
            <span>{chipSource(memory)}</span>
            <span aria-hidden="true">·</span>
            <button type="button" onClick={() => nav.toPluginPanel(MEMORY_PATH)} className="underline-offset-2 hover:text-foreground hover:underline">open memory</button>
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function FromHoncho({ message }: ExperimentalMessageMetadataProps) {
  // User rows mount too, only to tell the shared store where each turn starts; they render nothing.
  return <Matched threadId={message.threadId} message={{ id: message.id, createdAt: message.createdAt, turnId: message.turnId, role: message.role }} />;
}

function Matched({ threadId, message }: { threadId: string; message: Known }) {
  const { injections, users, assistants } = useInjections(threadId, message);
  if (message.role !== "assistant") return null;
  const memory: TurnMemory = { session: [], turn: [] };
  for (const i of injections) {
    const owner = ownersOf(i, users);
    if (!owner || firstReplyOf(owner, users, assistants)?.id !== message.id) continue;
    (i.kind === "session" ? memory.session : memory.turn).push(i);
  }
  if (memory.session.length === 0 && memory.turn.length === 0) return null;
  return <Chip memory={memory} />;
}

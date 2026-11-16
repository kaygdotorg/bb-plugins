import type { ConclusionView, ThreadMemoryStatus } from "../lib/contract";

export function ago(at: number | null | undefined, now = Date.now()): string {
  if (!at) return "never";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86_400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86_400)}d ago`;
}

export function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function plural(n: number, word: string): string {
  return `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
}

/** Words that name a group of chats, in plain language. The backend calls it a scope. */
export const GROUP_HINT = "chats from the same repo or project share memory";

/** The one-line thread status shared by the card row, the Info row and the banner segment. */
export function statusLine(status: ThreadMemoryStatus, queued: number, now = Date.now()): string {
  const group = status.scope ? ` · group ${status.scope}` : "";
  switch (status.state) {
    case "saving": return `memory · saving${status.lastUploadAt ? ` · saved ${ago(status.lastUploadAt, now)}` : ""}${group}`;
    case "idle": return status.lastUploadAt ? `memory · saved ${ago(status.lastUploadAt, now)}${group}` : `memory · on${group}`;
    case "paused": return `memory · paused${group}`;
    case "offline": return `memory · offline · ${queued} waiting${group}`;
    case "not-captured": return "memory · not captured";
  }
}

/** Lowercased words of a search, for matching by substring. */
export function searchWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

export function isExactMatch(content: string, words: readonly string[]): boolean {
  const text = content.toLowerCase();
  return words.some((w) => text.includes(w));
}

/** Exact word matches first (stable), then the rest. Display only. */
export function splitMatches<T extends { content: string }>(items: readonly T[], query: string): { exact: T[]; related: T[] } {
  const words = searchWords(query);
  const exact: T[] = [];
  const related: T[] = [];
  for (const item of items) (words.length > 0 && isExactMatch(item.content, words) ? exact : related).push(item);
  return { exact, related };
}

/**
 * Activity summaries come reworded from the backend. Older ones still carry internal words, so
 * known legacy shapes are mapped to plain text here. Anything else passes through, except the
 * word "scope", which always reads as "group".
 */
export function plainSummary(summary: string): string {
  let m = /^per-turn memory: (\d+) excerpts?$/.exec(summary);
  if (m) return `looked up ${m[1] === "1" ? "1 memory" : `${m[1]} memories`} for a message`;
  m = /^session memory injected \(scope ([^,)]+)(, from parent thread)?(, stale)?\)$/.exec(summary);
  if (m) return `gave the assistant memory for group ${m[1]}${m[2] ? ", from the parent chat" : ""}${m[3] ? " (out of date)" : ""}`;
  if (/^session rebuilt with the harness capture off at seq \d+/.test(summary)) return "this chat restarted without the old honcho plugin. memory will save it once that plugin is quiet";
  if (/^re-checked the switch-over/.test(summary)) return "checked again: this chat has not restarted since the old honcho plugin was turned off, so saving waits for a restart";
  return summary.replace(/\bscope\b/g, "group").replace(/\bharness\b/g, "assistant").replace(/\bseq (\d+)/g, "message $1");
}

export const STALE_MS = 10 * 60_000;

/** What a status line says before the first answer arrives, so the control is never missing. */
export const STATUS_LOADING = "memory · checking";

export type Origin = "agent" | "learned" | "confirmed";

/**
 * Where a conclusion came from. The backend sends `origin`; older results only carry the
 * agentWritten and confirmed flags, so fall back to those.
 */
export function originOf(c: ConclusionView): Origin {
  const origin = (c as { origin?: unknown }).origin;
  if (origin === "agent" || origin === "learned" || origin === "confirmed") return origin;
  if (c.confirmed) return "confirmed";
  return c.agentWritten ? "agent" : "learned";
}

export const ORIGIN_WORDS: Record<Origin, { label: string; hint: string }> = {
  learned: { label: "learned", hint: "memory worked this out from your chats" },
  agent: { label: "written by an agent", hint: "an agent saved this itself and nobody has checked it yet" },
  confirmed: { label: "confirmed", hint: "you said this is right" },
};

/** One problem with one line of a rules box, as the server reports it. */
/** index is null when the problem is with the whole list rather than one line. */
export interface LineError { field: string; index: number | null; message: string }

/**
 * Pulls structured line errors out of whatever a failed save carried: rpc issues (path is
 * [field, index]), an `errors` list on the error or its data, or the same list as JSON in the message.
 */
export function lineErrors(error: unknown): LineError[] {
  const out: LineError[] = [];
  const take = (item: unknown) => {
    if (!item || typeof item !== "object") return;
    const o = item as { field?: unknown; index?: unknown; message?: unknown; path?: unknown };
    const path = Array.isArray(o.path) ? o.path : [];
    const field = typeof o.field === "string" ? o.field : typeof path[0] === "string" ? path[0] : null;
    const index = typeof o.index === "number" ? o.index : typeof path[1] === "number" ? path[1] : null;
    if (field !== null && typeof o.message === "string") out.push({ field, index, message: o.message });
  };
  const list = (value: unknown) => { if (Array.isArray(value)) value.forEach(take); };
  const e = error as { issues?: unknown; errors?: unknown; data?: { errors?: unknown; issues?: unknown }; details?: unknown; message?: unknown } | null;
  if (e) {
    list(e.issues); list(e.errors); list(e.data?.errors); list(e.data?.issues); list(e.details);
    if (out.length === 0 && typeof e.message === "string") {
      const start = e.message.indexOf("[");
      if (start >= 0) { try { list(JSON.parse(e.message.slice(start))); } catch { /* plain text */ } }
    }
  }
  return out;
}

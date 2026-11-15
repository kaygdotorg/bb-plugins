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

/** The one-line thread status shared by the card row and the banner segment. */
export function statusLine(status: ThreadMemoryStatus, queued: number, now = Date.now()): string {
  switch (status.state) {
    case "saving": return status.lastUploadAt ? `memory · saving · ${ago(status.lastUploadAt, now)}` : "memory · saving";
    case "idle": return status.lastUploadAt ? `memory · saved · ${ago(status.lastUploadAt, now)}` : "memory · on";
    case "paused": return "memory · paused";
    case "offline": return `memory · offline · ${queued} waiting`;
    case "not-captured": return "memory · not captured";
  }
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

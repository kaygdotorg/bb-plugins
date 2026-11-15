import type { ThreadMemoryStatus } from "../lib/contract";

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
    case "offline": return `memory · offline · ${queued} queued`;
    case "not-captured": return "memory · not captured";
  }
}

export const STALE_MS = 10 * 60_000;

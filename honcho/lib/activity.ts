import type { ActivityEntry, ActivityKind, ActivityLog } from "./contract.js";

export const ACTIVITY_CAPACITY = 2000;

/** In-memory ring buffer of recent activity. Nothing is persisted: summaries are already redacted
 * by the callers, and the log is only a live view for the Memory page. */
export class RingActivityLog implements ActivityLog {
  private readonly entries: ActivityEntry[] = [];
  private readonly listeners = new Set<(entry: ActivityEntry) => void>();
  private nextId = 1;
  constructor(private readonly capacity = ACTIVITY_CAPACITY, private readonly clock: () => number = Date.now) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Activity capacity must be a positive integer.");
  }
  record(entry: Omit<ActivityEntry, "id" | "at">): void {
    const stored: ActivityEntry = { ...entry, id: this.nextId++, at: this.clock() };
    this.entries.push(stored);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    // A misbehaving listener must never break capture.
    for (const listener of [...this.listeners]) { try { listener({ ...stored }); } catch { /* ignore */ } }
  }
  /** Newest first. */
  list(opts: { limit?: number; threadId?: string; kinds?: ActivityKind[] } = {}): ActivityEntry[] {
    const out: ActivityEntry[] = [];
    const limit = opts.limit ?? this.capacity;
    for (let i = this.entries.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.entries[i];
      if (opts.threadId !== undefined && e.threadId !== opts.threadId) continue;
      if (opts.kinds && !opts.kinds.includes(e.kind)) continue;
      out.push({ ...e });
    }
    return out;
  }
  subscribe(fn: (entry: ActivityEntry) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }
}

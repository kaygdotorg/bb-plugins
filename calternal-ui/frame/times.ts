/**
 * Message times. bb renders none for your messages (and none at all in the phone layout), so the
 * overlay (which can call the plugin's RPC) registers a loader here and msg-times.ts (a plain content
 * script) asks for times through it. Cached per thread for 30s; `fresh` skips the cache (a new message).
 */
type Loader = (threadId: string) => Promise<Record<string, number>>;

let loader: Loader | null = null;
const cache = new Map<string, { at: number; times: Record<string, number> }>();

export function registerTimesLoader(next: Loader | null) {
  loader = next;
}

/** Times for a thread's rows, keyed by [data-timeline-row-id]; {} if unavailable. */
export async function messageTimes(threadId: string, fresh = false): Promise<Record<string, number>> {
  const hit = cache.get(threadId);
  if (hit && !fresh && Date.now() - hit.at < 30_000) return hit.times;
  if (!loader) return {};
  try {
    const times = await loader(threadId);
    cache.set(threadId, { at: Date.now(), times });
    return times;
  } catch {
    return {};
  }
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

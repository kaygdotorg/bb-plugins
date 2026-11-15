import type { ExperimentalBadge } from "@get-bb/plugin-sdk/app";
import { useRemote } from "./data";
import { STALE_MS } from "./format";
import { useNow } from "./data";

/** Quiet unless something needs you: auth failing, a tripwire hit, or an upload stuck 10+ minutes. */
export function useMemoryBadge(): ExperimentalBadge | null {
  const health = useRemote("health", {}, { pollMs: 30_000 });
  const now = useNow(30_000);
  const h = health.data;
  if (!h) return null;
  if (h.authFailing) return { tone: "critical", text: "auth", label: "memory: the memory server rejected the key" };
  if (h.tripwire) return { tone: "critical", text: "check", label: "memory: the old honcho plugin is still saving one chat. it stops by itself after that chat restarts" };
  if (h.oldestPendingAt !== null && now - h.oldestPendingAt > STALE_MS) {
    return { tone: "warning", count: Math.max(1, h.queued), label: `memory: ${h.queued} messages are waiting to be saved` };
  }
  return null;
}

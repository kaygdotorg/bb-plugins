// The one definition of a fork's copied prefix, used by live capture and backfill.
//
// Forks and side chats start with the source's copied completed turns. bb copies them in one
// transaction before the fork's own first event, keeping their original createdAt, so they are
// the prefix of the fork's log older than the fork itself.

import type { CaptureEvent } from "../transform.js";

/** The event types read to find the boundary. */
export const FORK_SCAN_TYPES = ["client/turn/requested", "turn/input/accepted", "client/turn/rejected", "item/completed", "turn/completed",
  "system/operation", "thread/identity", "provider.env-resolved", "turn/started"] as const satisfies readonly CaptureEvent["type"][];

/** The last copied seq of a fork (0 when nothing was copied), undefined for a thread that is not
 * a fork or whose log is still empty (the boundary can't be told yet). */
export async function forkBoundarySeq(thread: { originKind?: string | null; createdAt: number },
  read: () => Promise<readonly CaptureEvent[]>): Promise<number | undefined> {
  if (thread.originKind !== "fork") return undefined;
  const events = await read();
  if (!events.length) return undefined;
  let boundary = 0;
  for (const e of events) { if (e.createdAt < thread.createdAt) boundary = e.seq; else break; }
  return boundary;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRealtimeConnectionState, useRpc } from "@get-bb/plugin-sdk/app";
import type { RpcMethods } from "../lib/contract";
import type { rpcContract } from "../lib/rpc-server";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export const useMemoryRpc = (): Rpc => useRpc<typeof rpcContract>();

export interface Remote<T> {
  data: T | null;
  /** The last fetch failed. data may still hold the previous value (stale). */
  error: string | null;
  loading: boolean;
  refetch(): Promise<void>;
}

interface Options {
  /** Slow safety net; realtime signals do the live updates. */
  pollMs?: number;
  /** Skip fetching (a hidden tab, a missing id). */
  enabled?: boolean;
  /** Refetch on the plugin's realtime signals (default). Off for a value only this page changes. */
  live?: boolean;
}

/** One rpc read that follows the plugin's realtime signals, reconnects and a slow poll. */
export function useRemote<K extends keyof RpcMethods>(method: K, input: RpcMethods[K][0], options: Options = {}): Remote<RpcMethods[K][1]> {
  const rpc = useMemoryRpc();
  const { pollMs = 30_000, enabled = true, live = true } = options;
  const [data, setData] = useState<RpcMethods[K][1] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const key = JSON.stringify(input);
  const inputRef = useRef(input);
  inputRef.current = input;
  const alive = useRef(true);
  const seq = useRef(0);

  const inflight = useRef(false);
  const again = useRef(false);

  // One request at a time. A signal that lands mid-request asks for one more run afterwards, so a
  // burst of activity signals never stacks up requests. An unchanged answer keeps the old object,
  // so nothing below re-renders for it.
  const refetch = useCallback(async () => {
    if (!enabled) return;
    if (inflight.current) { again.current = true; return; }
    inflight.current = true;
    try {
      do {
        again.current = false;
        const mine = ++seq.current;
        try {
          const value = await (rpc.call as (m: string, i: unknown) => Promise<RpcMethods[K][1]>)(method, inputRef.current);
          if (!alive.current || mine !== seq.current) continue;
          setData((old) => (old !== null && JSON.stringify(old) === JSON.stringify(value) ? old : value));
          setError(null);
        } catch (e) {
          if (!alive.current || mine !== seq.current) continue;
          setError(e instanceof Error ? e.message : "request failed");
        } finally {
          if (alive.current && mine === seq.current) setLoading(false);
        }
      } while (again.current && alive.current);
    } finally { inflight.current = false; }
  }, [rpc, method, enabled]);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    setLoading(enabled);
    void refetch();
    if (!enabled || pollMs <= 0) return;
    const timer = window.setInterval(() => void refetch(), pollMs);
    return () => window.clearInterval(timer);
  }, [refetch, key, pollMs, enabled]);

  useRealtime("changed", () => { if (live) void refetch(); });
  useRealtime("activity", () => { if (live) void refetch(); });
  const connection = useRealtimeConnectionState();
  const seen = useRef(connection);
  useEffect(() => {
    if (seen.current !== "connected" && connection === "connected") void refetch();
    seen.current = connection;
  }, [connection, refetch]);

  return { data, error, loading, refetch };
}

/** Run a mutation; the page refetches from the realtime signal, and again directly. */
export function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "failed"); }
    finally { setBusy(null); }
  }, []);
  return { busy, error, run };
}

/** Re-render every few seconds so "4s ago" stays honest. */
export function useNow(everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/** Chat titles and project names for raw ids, fetched once per set of ids. Unknown ids stay absent. */
export function useLabels(threadIds: readonly string[], projectIds: readonly string[] = []) {
  const threads = [...new Set(threadIds)].sort();
  const projects = [...new Set(projectIds)].sort();
  const enabled = threads.length + projects.length > 0;
  const labels = useRemote("labels.get", { threadIds: threads, projectIds: projects }, { enabled, pollMs: 0, live: false });
  return {
    thread: (id: string): string | null => labels.data?.threads[id] ?? null,
    project: (id: string): string | null => labels.data?.projects[id] ?? null,
  };
}

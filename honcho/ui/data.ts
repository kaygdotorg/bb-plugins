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
}

/** One rpc read that follows the plugin's realtime signals, reconnects and a slow poll. */
export function useRemote<K extends keyof RpcMethods>(method: K, input: RpcMethods[K][0], options: Options = {}): Remote<RpcMethods[K][1]> {
  const rpc = useMemoryRpc();
  const { pollMs = 30_000, enabled = true } = options;
  const [data, setData] = useState<RpcMethods[K][1] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(enabled);
  const key = JSON.stringify(input);
  const inputRef = useRef(input);
  inputRef.current = input;
  const alive = useRef(true);
  const seq = useRef(0);

  const refetch = useCallback(async () => {
    if (!enabled) return;
    const mine = ++seq.current;
    try {
      const value = await (rpc.call as (m: string, i: unknown) => Promise<RpcMethods[K][1]>)(method, inputRef.current);
      if (!alive.current || mine !== seq.current) return;
      setData(value);
      setError(null);
    } catch (e) {
      if (!alive.current || mine !== seq.current) return;
      setError(e instanceof Error ? e.message : "request failed");
    } finally {
      if (alive.current && mine === seq.current) setLoading(false);
    }
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

  useRealtime("changed", () => void refetch());
  useRealtime("activity", () => void refetch());
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

// The bb-secrets values as an in-memory deny set for redaction. Values are never
// logged or persisted: errors are swallowed without their text, and the only state
// is a Set plus a per-host fingerprint (path/mtime/size hash, no content).
import type { HostClient } from "./host-contract.js";
import { MIN_SECRET_LENGTH } from "./secrets-host.js";

export const SECRETS_REFRESH_MS = 5 * 60_000;

export interface SecretsService {
  /** Current values (loads once on first use). Always safe to call; failures yield the last good set. */
  values(): Promise<string[]>;
  /** Re-reads from every host now; hosts whose files are unchanged are not re-read. */
  refresh(): Promise<void>;
  /** Starts the 5 minute refresh timer; returns the stopper. */
  start(): () => void;
}

export interface SecretsOptions {
  host: Pick<HostClient, "call">;
  hostIds(): Promise<string[]>;
  intervalMs?: number;
  /** Absolute dotenv paths recorded by secret-request events (the only record bb keeps). */
  paths?(): Promise<string[]>;
}

/** The first line of `resolution.description.detail` of a secret-request lifecycle event is the dotenv path. */
export function secretRequestPaths(event: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== "object" || depth > 8) return;
    const o = node as Record<string, unknown>;
    if (o.rendererId === "secret-request") {
      const detail = (o.resolution as { description?: { detail?: unknown } } | undefined)?.description?.detail;
      const line = typeof detail === "string" ? detail.split(/\r?\n/)[0].trim() : "";
      if (line.startsWith("/")) out.push(line);
    }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(event, 0);
  return out;
}

export function createSecretsService(options: SecretsOptions): SecretsService {
  const perHost = new Map<string, { fingerprint: string; values: string[] }>();
  let loaded: Promise<void> | undefined;
  let running: Promise<void> | undefined;

  async function refreshOnce(): Promise<void> {
    let ids: string[] = [];
    try { ids = await options.hostIds(); } catch { return; }
    let paths: string[] = [];
    try { paths = (await options.paths?.()) ?? []; } catch { /* discovery is best effort */ }
    await Promise.all(ids.map(async (hostId) => {
      try {
        const known = perHost.get(hostId);
        const result = await options.host.call("secrets.read", { ...(known ? { fingerprint: known.fingerprint } : {}), ...(paths.length ? { paths } : {}) }, { hostId, signal: AbortSignal.timeout(15_000) });
        if (result.values) perHost.set(hostId, { fingerprint: result.fingerprint, values: result.values });
      } catch { /* host offline or old plugin version: keep the last good set; never log */ }
    }));
  }
  const refresh = () => (running ??= refreshOnce().finally(() => { running = undefined; }));

  return {
    async values() {
      await (loaded ??= refresh());
      const all = new Set<string>();
      for (const { values } of perHost.values()) for (const v of values) if (v.length >= MIN_SECRET_LENGTH) all.add(v);
      return [...all];
    },
    refresh,
    start() {
      const timer = setInterval(() => { void refresh(); }, options.intervalMs ?? SECRETS_REFRESH_MS);
      timer.unref?.();
      return () => clearInterval(timer);
    },
  };
}

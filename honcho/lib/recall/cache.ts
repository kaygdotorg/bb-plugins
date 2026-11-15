import { HonchoError, type Conclusion } from "../honcho-client.js";
import { defaultPeerCard, defaultScopeConclusions } from "./ports.js";
import type { RecallShared } from "./shared.js";

export const REFRESH_INTERVAL_MS = 5 * 60_000;
export const REFRESH_DEBOUNCE_MS = 1_500;
/** Debounced thread.active refreshes skip when the last success is this recent. */
export const REFRESH_MIN_GAP_MS = 60_000;
/** Data older than this is served marked stale. */
export const CACHE_TTL_MS = 6 * 60 * 60_000;
export const MAX_SCOPES = 16;
const SCOPE_CONCLUSIONS = 10;
const RECENT_CONCLUSIONS = 100;

export interface ScopeEntry { summary: string | null; conclusions: Conclusion[]; at: number }
export interface CacheSnapshot {
  peer: string | null;
  card: string[] | null;
  recent: Conclusion[];
  scopes: ReadonlyMap<string, ScopeEntry>;
  lastSuccess: number | null;
  stale: boolean;
}

/**
 * One global in-memory cache (not per thread). Session build reads it
 * synchronously; refreshes are single-flight, debounced, and keep the previous
 * data when Honcho is unreachable.
 */
export class MemoryCache {
  private peer: string | null = null;
  private card: string[] | null = null;
  private recent: Conclusion[] = [];
  private readonly scopes = new Map<string, ScopeEntry>();
  private readonly wanted: string[] = []; // LRU of scopes seen, newest last
  private lastSuccess: number | null = null;
  private lastFailed = false;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly shared: RecallShared, private readonly now: () => number = Date.now, private readonly log?: (m: string) => void) {}

  snapshot(): CacheSnapshot {
    const age = this.lastSuccess === null ? Infinity : this.now() - this.lastSuccess;
    return {
      peer: this.peer ?? this.shared.peerName, card: this.card, recent: this.recent, scopes: this.scopes,
      lastSuccess: this.lastSuccess, stale: this.lastSuccess !== null && (this.lastFailed || age > CACHE_TTL_MS),
    };
  }
  hasData(): boolean { return this.lastSuccess !== null; }

  /** Note a scope a thread uses; true when it has no cached entry yet. */
  want(scope: string): boolean {
    const i = this.wanted.indexOf(scope);
    if (i >= 0) this.wanted.splice(i, 1);
    this.wanted.push(scope);
    while (this.wanted.length > MAX_SCOPES) this.scopes.delete(this.wanted.shift()!);
    return !this.scopes.has(scope);
  }

  /** Debounced. `force` ignores the minimum gap (a new scope, startup). */
  request(force = false): void {
    if (!force && this.lastSuccess !== null && !this.lastFailed && this.now() - this.lastSuccess < REFRESH_MIN_GAP_MS) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.refresh().catch(() => undefined); }, REFRESH_DEBOUNCE_MS);
    this.timer.unref?.();
  }
  cancel(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; }

  refresh(): Promise<void> {
    if (!this.inFlight) this.inFlight = this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async run(): Promise<void> {
    try {
      const { client, peer } = await this.shared.client();
      const ports = this.shared.ports;
      const [card, recent] = await Promise.all([
        (ports.peerCard ?? defaultPeerCard)(client, peer),
        client.listConclusions({ observer: peer, observed: peer }, { size: RECENT_CONCLUSIONS, reverse: true }).then(p => p.items),
      ]);
      const level = await this.shared.keyLevel.get();
      const scopes = new Map<string, ScopeEntry>();
      for (const scope of [...this.wanted]) {
        if (level === "restricted") { scopes.set(scope, { summary: null, conclusions: [], at: this.now() }); continue; }
        try {
          const [rep, conclusions] = await Promise.all([
            client.peerRepresentation(peer, { scope, max_conclusions: 25 }),
            (ports.scopeConclusions ?? defaultScopeConclusions)(client, peer, scope, SCOPE_CONCLUSIONS),
          ]);
          scopes.set(scope, { summary: rep.representation ?? null, conclusions, at: this.now() });
        } catch (error) {
          if (error instanceof HonchoError && error.kind === "auth" && error.status === 403) {
            this.shared.keyLevel.noteForbidden();
            scopes.set(scope, { summary: null, conclusions: [], at: this.now() });
            continue;
          }
          throw error;
        }
      }
      this.peer = peer;
      this.card = card;
      this.recent = recent;
      for (const [scope, entry] of scopes) if (this.wanted.includes(scope)) this.scopes.set(scope, entry);
      this.lastSuccess = this.now();
      this.lastFailed = false;
    } catch (error) {
      this.lastFailed = true;
      this.log?.(`honcho recall refresh failed: ${error instanceof HonchoError ? error.kind : "error"}`);
      throw error;
    }
  }
}

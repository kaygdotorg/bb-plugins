import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ConclusionView, Deps, MemoryInjection, RecallService } from "../contract.js";
import type { Conclusion } from "../honcho-client.js";
import { MemoryCache, REFRESH_INTERVAL_MS } from "./cache.js";
import { clampHookBudget, RECALL_SETTING_DESCRIPTORS, type RecallPorts, type RecallSettings } from "./ports.js";
import { recallHostsKey, recallShared, toView, type RecallShared } from "./shared.js";

export type RecallDeps = Deps & { recall?: RecallPorts };
export type RecallRuntime = RecallService & {
  /** The periodic cache refresh, until `signal` aborts. Run it from a background service:
   * it starts once the factory completed, and bb aborts it on reload, disable and shutdown. */
  run(signal: AbortSignal): Promise<void>;
  /** Cancels the debounce timer; idempotent. */
  stop(): void;
  /** run() without a service, returning its stopper: for tests. */
  start(): () => void;
  /** Conclusions honcho_conclude saved from a thread; `attached: false` ones carry no session_id,
   * so deleting the thread's session leaves them and the delete path must purge them by id. */
  conclusionsForThread(threadId: string): Array<{ id: string; attached: boolean }>;
  /** Everything that reached the agent in this thread, oldest first: per-turn hits the hook reported as
   * served (joined to the stored excerpts) and session-build injections. `since` is epoch ms. */
  injections(input: { threadId: string; since?: number }): Promise<MemoryInjection[]>;
};

/** Pages of 100 scanned for exact word matches; semantic matches only fill up to this many results, within this cosine distance. */
const EXACT_SCAN_PAGES = 5;
const SEMANTIC_BELOW = 10;
const SEMANTIC_DISTANCE = 0.5;
const TITLE_TTL_MS = 5 * 60_000;

export interface RecallInternals {
  shared: RecallShared;
  cache: MemoryCache;
  settings: RecallSettings;
  deps: RecallDeps;
}
const internals = new WeakMap<RecallRuntime, RecallInternals>();
export function recallInternals(recall: RecallRuntime): RecallInternals {
  const value = internals.get(recall);
  if (!value) throw new Error("Not a recall service created by createRecallService.");
  return value;
}

function defineSettings(bb: BbPluginApi): RecallSettings {
  const handle = bb.settings.define(RECALL_SETTING_DESCRIPTORS);
  let values = { codexUseBbTools: RECALL_SETTING_DESCRIPTORS.codexUseBbTools.default as boolean, hookBudgetMs: RECALL_SETTING_DESCRIPTORS.hookBudgetMs.default as number };
  const apply = (next: { codexUseBbTools: boolean; hookBudgetMs: number }) => { values = { codexUseBbTools: next.codexUseBbTools === true, hookBudgetMs: next.hookBudgetMs } };
  void handle.get().then(apply, () => undefined);
  handle.onChange(apply);
  return {
    codexUseBbTools: () => values.codexUseBbTools,
    hookBudgetMs: () => clampHookBudget(values.hookBudgetMs),
  };
}

export function createRecallService(bb: BbPluginApi, deps: RecallDeps): RecallRuntime {
  const shared = recallShared(bb, deps, deps.recall);
  const cache = new MemoryCache(shared, Date.now, m => bb.log.warn(m));
  shared.invalidateMemory = () => cache.invalidate().catch(() => undefined);
  const settings = deps.recall?.settings ?? defineSettings(bb);

  bb.events.on("thread.active", ({ thread }) => {
    cache.request();
    // Session build reads the deny answer synchronously; have it ready.
    void shared.gate.checkDenied({ id: thread.id, projectId: thread.projectId, environmentId: thread.environmentId ?? null });
  });

  const views = (items: readonly Conclusion[]): ConclusionView[] => {
    const marks = shared.store.many(items.map(c => c.id));
    return items.map(c => toView(c, marks.get(c.id)));
  };

  const titles = new Map<string, { title: string | null; at: number }>();
  const titleOf = async (threadId: string): Promise<string | null> => {
    const hit = titles.get(threadId);
    if (hit && Date.now() - hit.at < TITLE_TTL_MS) return hit.title;
    let title: string | null = null;
    try { title = (await bb.sdk.threads.get({ threadId }))?.title?.trim() || null; } catch { /* unknown or deleted thread */ }
    titles.set(threadId, { title, at: Date.now() });
    return title;
  };

  const recall: RecallRuntime = {
    async injections({ threadId, since = 0 }) {
      const out: MemoryInjection[] = [];
      const seen = new Set<string>();
      const hosts = (await bb.storage.kv.get<string[]>(recallHostsKey(threadId)).catch(() => undefined)) ?? [];
      for (const hostId of shared.host ? hosts : []) {
        let notes: Array<{ hash: string; counter: number; at: number }>;
        try { notes = (await shared.host!.call("recall.served", { threadId, since }, { hostId, signal: AbortSignal.timeout(10_000) })).notes; }
        catch { continue; }
        for (const note of notes) {
          const key = `${note.hash}:${note.counter}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const record = shared.store.turnInjection(threadId, note.hash, note.counter);
          if (!record || !record.items.length) continue;
          out.push({ kind: "turn", at: note.at, scope: record.scope, items: record.items.map(i => ({ ...i, sourceTitle: null })) });
        }
      }
      for (const s of shared.store.sessionInjections(threadId, since)) out.push({ kind: "session", at: s.at, scope: s.scope, items: [], card: s.card });
      const ids = new Set(out.flatMap(i => i.items.flatMap(it => it.sourceThreadId ? [it.sourceThreadId] : [])));
      const known = new Map(await Promise.all([...ids].map(async id => [id, await titleOf(id)] as const)));
      for (const injection of out) for (const item of injection.items) item.sourceTitle = item.sourceThreadId ? known.get(item.sourceThreadId) ?? null : null;
      return out.sort((a, b) => a.at - b.at);
    },
    async threadContext(threadId) {
      const scope = shared.scopes.known(threadId);
      let stale = false;
      // Never block the card on a refresh (representation can take ~30 s on a slow server): wait a
      // short moment for a first fill, then serve what's cached and let the refresh land on its own.
      const wanted = (scope && cache.want(scope)) || !cache.hasData();
      if (wanted) {
        const refreshing = cache.refresh().catch(() => { stale = true; });
        await Promise.race([refreshing, new Promise(r => setTimeout(r, 1_500))]);
      }
      const snap = cache.snapshot();
      stale ||= snap.stale;
      const top = scope ? views(snap.scopes.get(scope)?.conclusions ?? []) : [];
      let fromThread: ConclusionView[];
      try {
        const { client } = await shared.client();
        fromThread = views((await client.listConclusions({ session_id: threadId }, { size: 50 })).items);
        const known = new Set(fromThread.map(c => c.id));
        // Conclusions saved without a session (the session did not exist yet) are joined from local marks.
        const local = shared.store.forThread(threadId).filter(m => !known.has(m.id));
        if (local.length) fromThread.push(...views(snap.recent.filter(c => local.some(m => m.id === c.id))));
      } catch {
        stale = true;
        const ids = new Set(shared.store.forThread(threadId).map(m => m.id));
        fromThread = views(snap.recent.filter(c => ids.has(c.id) || c.session_id === threadId));
      }
      return { scope, top, fromThread, stale };
    },
    async conclusions(opts) {
      const { client, peer } = await shared.client();
      const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
      const query = [opts.query, opts.scope].filter((s): s is string => !!s?.trim()).join(" ");
      if (!query) return views((await client.listConclusions({ observer: peer, observed: peer }, { size: limit, reverse: true })).items);
      // Display only, never deletes. Exact word matches first, then close semantic matches below a distance cut.
      const words = [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
      const exact: Conclusion[] = [];
      const seen = new Set<string>();
      for (let page = 1; page <= EXACT_SCAN_PAGES && exact.length < limit; page++) {
        const res = await client.listConclusions({ observer: peer, observed: peer }, { size: 100, page, reverse: true });
        for (const c of res.items) if (!seen.has(c.id) && words.some(w => c.content.toLowerCase().includes(w))) { seen.add(c.id); exact.push(c); }
        if (res.items.length < 100 || (res.pages !== undefined && page >= res.pages)) break;
      }
      const out = exact.slice(0, limit);
      if (out.length < SEMANTIC_BELOW) {
        const room = Math.min(limit, SEMANTIC_BELOW) - out.length;
        const near = await client.queryConclusions({ query, top_k: Math.min(100, room + out.length), distance: SEMANTIC_DISTANCE, filters: { observer: peer, observed: peer } });
        for (const c of near) if (out.length < SEMANTIC_BELOW && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
      }
      return views(out);
    },
    async deleteConclusion(id) {
      const { client } = await shared.client();
      await client.deleteConclusion(id);
      shared.store.forget(id);
      deps.activity.record({ kind: "delete", summary: "deleted 1 conclusion" });
      await shared.invalidateMemory();
    },
    conclusionsForThread: threadId => shared.store.conclusionsForThread(threadId),
    async confirmConclusion(id) {
      shared.store.confirm(id);
      cache.request(true);
    },
    async run(signal) {
      if (signal.aborted) return;
      void cache.refresh().catch(() => undefined);
      const interval = setInterval(() => { void cache.refresh().catch(() => undefined); }, REFRESH_INTERVAL_MS);
      interval.unref?.();
      await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      clearInterval(interval);
      cache.cancel();
    },
    stop() { cache.cancel(); },
    start() {
      const controller = new AbortController();
      void recall.run(controller.signal);
      return () => { controller.abort(); recall.stop(); };
    },
  };
  internals.set(recall, { shared, cache, settings, deps });
  return recall;
}

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ConclusionView, Deps, RecallService } from "../contract.js";
import type { Conclusion } from "../honcho-client.js";
import { MemoryCache, REFRESH_INTERVAL_MS } from "./cache.js";
import { clampHookBudget, RECALL_SETTING_DESCRIPTORS, type RecallPorts, type RecallSettings } from "./ports.js";
import { recallShared, toView, type RecallShared } from "./shared.js";

export type RecallDeps = Deps & { recall?: RecallPorts };
export type RecallRuntime = RecallService & {
  start(): () => void;
  /** Conclusions honcho_conclude saved from a thread; `attached: false` ones carry no session_id,
   * so deleting the thread's session leaves them and the delete path must purge them by id. */
  conclusionsForThread(threadId: string): Array<{ id: string; attached: boolean }>;
};

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

  const recall: RecallRuntime = {
    async threadContext(threadId) {
      const scope = shared.scopes.known(threadId);
      let stale = false;
      if (scope && cache.want(scope)) { await cache.refresh().catch(() => { stale = true; }); }
      else if (!cache.hasData()) { await cache.refresh().catch(() => { stale = true; }); }
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
      const items = query
        ? await client.queryConclusions({ query, top_k: limit, filters: { observer: peer, observed: peer } })
        : (await client.listConclusions({ observer: peer, observed: peer }, { size: limit, reverse: true })).items;
      return views(items);
    },
    async deleteConclusion(id) {
      const { client } = await shared.client();
      await client.deleteConclusion(id);
      shared.store.forget(id);
      deps.activity.record({ kind: "delete", summary: "deleted 1 conclusion" });
      cache.request(true);
    },
    conclusionsForThread: threadId => shared.store.conclusionsForThread(threadId),
    async confirmConclusion(id) {
      shared.store.confirm(id);
      cache.request(true);
    },
    start() {
      void cache.refresh().catch(() => undefined);
      const interval = setInterval(() => { void cache.refresh().catch(() => undefined); }, REFRESH_INTERVAL_MS);
      interval.unref?.();
      let stopped = false;
      const stop = () => { if (stopped) return; stopped = true; clearInterval(interval); cache.cancel(); };
      bb.onDispose(stop);
      return stop;
    },
  };
  internals.set(recall, { shared, cache, settings, deps });
  return recall;
}

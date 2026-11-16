import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import type { Deps, ForgetGroupPlan, GroupDetail, GroupView } from "./contract.js";
import type { Conclusion, Page, Session } from "./honcho-client.js";
import { redact } from "./redact.js";
import { scopeKey } from "./capture/scope.js";

const fail = (message: string): never => { throw new experimental_PluginRpcRefusal({ code: "invalid", message }); };
/** A partial scan must never become a destructive plan. */
export async function completePages<T>(read: (page: number) => Promise<Page<T>>, max = 50_000): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const result = await read(page);
    all.push(...result.items);
    const done = result.pages != null ? page >= result.pages : result.total != null ? all.length >= result.total : result.items.length < 100;
    if (done) return all;
    if (!result.items.length || all.length >= max) return fail("This group is too large to scan completely here. No data was deleted.");
  }
}
export function derivedFrom(own: Set<string>, conclusions: Conclusion[]): string[] {
  const doomed = new Set(own);
  for (let grew = true; grew;) {
    grew = false;
    for (const c of conclusions) if (!doomed.has(c.id) && c.source_ids?.some(id => doomed.has(id))) { doomed.add(c.id); grew = true; }
  }
  return [...doomed].sort();
}

export function createGroupService(bb: Pick<BbPluginApi, "sdk" | "storage">, deps: Deps, secretValues?: () => Promise<string[]>, patterns?: () => Promise<RegExp[]>, forgotten?: (group: string, conclusions: string[]) => void) {
  type Snapshot = { sessionIds: string[]; conclusionIds: string[]; messages: number; identity: string };
  const plans = new Map<string, { view: ForgetGroupPlan; snapshot: Snapshot }>();
  const identity = async () => { const { config } = await deps.config(); return createHash("sha256").update(JSON.stringify(config)).digest("hex"); };
  const clean = async (text: string) => redact(text, { deny: [...(await deps.config()).keys, ...(await secretValues?.() ?? [])], patterns: await patterns?.() ?? [] }).text;
  async function sessions(group: string): Promise<Session[]> {
    const client = await deps.client();
    return (await completePages(page => client.listScopeSessions(group, { page, size: 100 }))).filter(s => s.is_active !== false);
  }
  async function list(): Promise<GroupView[]> {
    const client = await deps.client();
    const groups = await completePages(page => client.listScopes({ page, size: 100 }));
    const threads = await bb.sdk.threads.list();
    const latest = new Map<string, number>();
    for (const t of threads) {
      const scope = await bb.storage.kv.get<string>(scopeKey(t.id));
      if (scope) latest.set(scope, Math.max(latest.get(scope) ?? 0, t.updatedAt));
    }
    const out: GroupView[] = [];
    // Keep server load bounded; group details are only loaded on demand.
    for (const group of groups) {
      const count = group.session_count ?? (await sessions(group.id)).length;
      out.push({ id: group.id, chats: count, lastActivity: latest.get(group.id) ?? null, paused: deps.outbox.groupPaused(group.id) });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }
  async function get(group: string): Promise<GroupDetail> {
    const [client, { config }, chats] = await Promise.all([deps.client(), deps.config(), sessions(group)]);
    const representation = await client.peerRepresentation(config.peerName, { scope: group });
    return {
      summary: await clean(representation.representation ?? ""), paused: deps.outbox.groupPaused(group),
      chats: await Promise.all(chats.map(async s => { const thread = await bb.sdk.threads.get({ threadId: s.id }).catch(() => null); return { id: s.id, title: thread?.title ? await clean(thread.title) : null, lastActivity: thread?.updatedAt ?? Date.parse(s.created_at) }; })),
    };
  }
  async function snapshot(group: string): Promise<Snapshot> {
    const connection = await identity();
    const client = await deps.client();
    const chats = await sessions(group);
    const own = new Set<string>();
    let messages = 0;
    for (const chat of chats) {
      const count = await client.listMessages(chat.id, {}, { size: 1 });
      if (count.total == null) return fail("Honcho did not return complete message counts. No data was deleted.");
      messages += count.total;
      const cs = await completePages(page => client.listConclusions({ session_id: chat.id }, { page, size: 100 }));
      for (const c of cs) own.add(c.id);
    }
    const all = own.size ? await completePages(page => client.listConclusions({}, { page, size: 100 })) : [];
    if (await identity() !== connection) return fail("The connection changed. Preview the group again.");
    return { sessionIds: chats.map(s => s.id).sort(), conclusionIds: derivedFrom(own, all), messages, identity: connection };
  }
  async function preview(group: string): Promise<ForgetGroupPlan> {
    for (const [token, p] of plans) if (p.view.expiresAt < Date.now()) plans.delete(token);
    if (plans.size >= 20) plans.delete(plans.keys().next().value!);
    const s = await snapshot(group);
    const view = { token: randomUUID(), group, sessions: s.sessionIds.length, messages: s.messages, conclusions: s.conclusionIds.length, expiresAt: Date.now() + 300_000 };
    plans.set(view.token, { view, snapshot: s }); return view;
  }
  async function forget(group: string, confirmation: string, token: string) {
    const p = plans.get(token);
    if (!p || p.view.group !== group || p.view.expiresAt < Date.now() || confirmation !== group) return fail("Preview this group and type its exact name before deleting.");
    plans.delete(token); // A preview can only be consumed once, including concurrent clicks.
    const current = await snapshot(group);
    if (JSON.stringify(current) !== JSON.stringify(p.snapshot)) return fail("The group changed since preview. Check the new counts before deleting.");
    // Pause before deletion so queued or future capture cannot recreate the group’s sessions.
    deps.outbox.setGroupPaused(group, true);
    const client = await deps.client();
    if (await identity() !== current.identity) return fail("The connection changed. Preview the group again.");
    const owner = `forget:${randomUUID()}`;
    const held: string[] = [];
    const hold = () => {
      for (const id of current.sessionIds) {
        if (!deps.outbox.acquireLease(id, owner, Date.now(), 60_000)) return fail("A chat is still uploading. The group remains paused; preview again when it finishes.");
        if (!held.includes(id)) held.push(id);
      }
    };
    try {
      hold();
      for (const session of current.sessionIds) { hold(); await client.deleteSession(session); }
      for (const conclusion of current.conclusionIds) { hold(); await client.deleteConclusion(conclusion); }
    } catch { return fail("The group could not be completely deleted and remains paused. Preview again to finish the remaining items."); }
    finally { for (const id of held) deps.outbox.releaseLease(id, owner); }
    forgotten?.(group, current.conclusionIds);
    deps.activity.record({ kind: "delete", summary: `Forgot group ${group}; it remains paused. Honcho finishes session cleanup in the background.` });
    return { ok: true } as const;
  }
  return {
    list, get, preview, forget,
    async pause(group: string, paused: boolean) { deps.outbox.setGroupPaused(group, paused); return { ok: true } as const; },
    async search(group: string, query: string) {
      const found = await (await deps.client()).searchWorkspace({ query: await clean(query), scope: group, limit: 30 });
      return Promise.all(found.map(async m => ({ content: await clean(m.content), sessionId: m.session_id, date: m.created_at })));
    },
    async ask(group: string, query: string) {
      const answer = await (await deps.client()).workspaceChat({ query: await clean(query), scope: group, reasoning_level: "low" });
      return { content: answer.content ? await clean(answer.content) : null };
    },
  };
}

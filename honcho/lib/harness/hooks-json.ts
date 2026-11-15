// Edits of hooks files shaped `{ hooks: { <Event>: [ { matcher?, hooks: [handler] } ] } }`,
// which Claude Code's settings.json and Codex's hooks.json share, plus Codex's
// hook trust hash.
import { createHash } from "node:crypto";
import { isRecord } from "./schema.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export interface Handler { type: "command"; command: string; timeout: number; statusMessage?: string }
export interface DesiredHook { event: string; matcher?: string; handler: Handler }

/** Our guard is recognised by its file name, wherever the bb-owned copy lives. */
export const OWN_HOOK = /bb-honcho-hook\.sh/;
/** codex-honcho's own ownership test (src/connectors/codex.ts isOwnedCommand). */
const CODEX_HONCHO = /codex-honcho\b[\s\S]*\b(recall|prompt|observe|writeback)\b/;
export const isCodexHonchoCommand = (command: unknown) => typeof command === "string" && CODEX_HONCHO.test(command);
export const isOwnCommand = (command: unknown) => typeof command === "string" && OWN_HOOK.test(command);

function groupsOf(file: JsonObject, event: string): Json[] {
  const hooks = file.hooks;
  if (!isRecord(hooks)) return [];
  const groups = (hooks as JsonObject)[event];
  return Array.isArray(groups) ? groups : [];
}

function handlersOf(group: Json): Json[] {
  return isRecord(group) && Array.isArray((group as JsonObject).hooks) ? ((group as JsonObject).hooks as Json[]) : [];
}

const sameHandler = (group: Json, desired: DesiredHook) => {
  if (!isRecord(group)) return false;
  const g = group as JsonObject;
  const handlers = handlersOf(group);
  if ((g.matcher ?? undefined) !== desired.matcher || handlers.length !== 1) return false;
  return JSON.stringify(handlers[0]) === JSON.stringify(desired.handler);
};

/** True when exactly the desired group is present (and is our only entry for that event). */
export function hasHook(file: JsonObject, desired: DesiredHook): boolean {
  const groups = groupsOf(file, desired.event);
  const ours = groups.filter((g) => handlersOf(g).some((h) => isRecord(h) && isOwnCommand((h as JsonObject).command)));
  return ours.length === 1 && sameHandler(ours[0]!, desired);
}

/**
 * Makes `desired` our single entry for its event. Leaves the file untouched when
 * it already is (so indices and codex trust keys stay put); otherwise removes our
 * stale handlers in that event and appends a fresh group. Returns the new object.
 */
export function ensureHook(file: JsonObject, desired: DesiredHook): JsonObject {
  if (hasHook(file, desired)) return file;
  const next: JsonObject = { ...file };
  const hooks: JsonObject = isRecord(file.hooks) ? { ...(file.hooks as JsonObject) } : {};
  const kept: Json[] = [];
  for (const group of groupsOf(file, desired.event)) {
    const handlers = handlersOf(group);
    const others = handlers.filter((h) => !(isRecord(h) && isOwnCommand((h as JsonObject).command)));
    if (others.length === handlers.length) kept.push(group);
    else if (others.length > 0) kept.push({ ...(group as JsonObject), hooks: others });
  }
  const group: JsonObject = {};
  if (desired.matcher !== undefined) group.matcher = desired.matcher;
  group.hooks = [{ ...desired.handler } as unknown as JsonObject];
  hooks[desired.event] = [...kept, group];
  next.hooks = hooks;
  return next;
}

/** Index of one handler for codex trust keys. */
export interface HookPosition { event: string; group: number; handler: number }

/**
 * Drops every handler `remove` matches, and empty groups and events (like
 * codex-honcho's withoutOwnHooks). Reports where each surviving handler moved.
 */
export function removeHandlers(file: JsonObject, remove: (handler: Json) => boolean): {
  file: JsonObject; removed: HookPosition[]; moved: Array<{ from: HookPosition; to: HookPosition }>;
} {
  const removed: HookPosition[] = [];
  const moved: Array<{ from: HookPosition; to: HookPosition }> = [];
  if (!isRecord(file.hooks)) return { file, removed, moved };
  const hooks: JsonObject = {};
  for (const [event, groups] of Object.entries(file.hooks as JsonObject)) {
    if (!Array.isArray(groups)) { hooks[event] = groups; continue; }
    const keptGroups: Json[] = [];
    groups.forEach((group, g) => {
      const handlers = handlersOf(group);
      if (!isRecord(group) || !Array.isArray((group as JsonObject).hooks)) { keptGroups.push(group); return; }
      const kept: Json[] = [];
      handlers.forEach((handler, h) => {
        if (remove(handler)) { removed.push({ event, group: g, handler: h }); return; }
        moved.push({ from: { event, group: g, handler: h }, to: { event, group: keptGroups.length, handler: kept.length } });
        kept.push(handler);
      });
      if (kept.length === handlers.length) keptGroups.push(group);
      else if (kept.length > 0) keptGroups.push({ ...(group as JsonObject), hooks: kept });
    });
    if (keptGroups.length > 0) hooks[event] = keptGroups;
  }
  return { file: { ...file, hooks }, removed, moved };
}

/** The handler at a position, which must exist. */
export function handlerAt(file: JsonObject, at: HookPosition): Json {
  return handlersOf(groupsOf(file, at.event)[at.group]!)[at.handler]!;
}

/** The first handler identical to `handler` in `event`. */
export function locateHandler(file: JsonObject, event: string, handler: Json): HookPosition | null {
  const want = JSON.stringify(handler);
  const groups = groupsOf(file, event);
  for (let g = 0; g < groups.length; g += 1) {
    const handlers = handlersOf(groups[g]!);
    for (let h = 0; h < handlers.length; h += 1) if (JSON.stringify(handlers[h]) === want) return { event, group: g, handler: h };
  }
  return null;
}

/**
 * Puts handlers that `removeHandlers` took out of `source` back into `target`,
 * at their old positions where the file still lines up: a whole removed group
 * goes back as a group, a lone handler back into its old group. A handler that
 * is already present is not added twice. Returns `target` itself if nothing was
 * missing; events are put back in `source`'s order.
 */
export function reinsertHandlers(target: JsonObject, source: JsonObject, removed: HookPosition[]): JsonObject {
  if (target.hooks !== undefined && !isRecord(target.hooks)) return target;
  const hooks: JsonObject = isRecord(target.hooks) ? { ...(target.hooks as JsonObject) } : {};
  let changed = false;
  const byEvent = new Map<string, Map<number, number[]>>();
  for (const at of removed) {
    const groups = byEvent.get(at.event) ?? new Map<number, number[]>();
    groups.set(at.group, [...(groups.get(at.group) ?? []), at.handler]);
    byEvent.set(at.event, groups);
  }
  for (const [event, byGroup] of byEvent) {
    const existing = hooks[event];
    if (existing !== undefined && !Array.isArray(existing)) continue;
    const groups: Json[] = Array.isArray(existing) ? [...existing] : [];
    const present = (handler: Json) => groups.some((g) => handlersOf(g).some((h) => JSON.stringify(h) === JSON.stringify(handler)));
    const sourceGroups = groupsOf(source, event);
    for (const g of [...byGroup.keys()].sort((a, b) => a - b)) {
      const src = sourceGroups[g] as JsonObject;
      const srcHandlers = handlersOf(src);
      const indices = byGroup.get(g)!.sort((a, b) => a - b);
      const missing = indices.filter((h) => !present(srcHandlers[h]!));
      if (!missing.length) continue;
      changed = true;
      const fresh = (): JsonObject => ({ ...src, hooks: missing.map((h) => srcHandlers[h]!) });
      if (indices.length === srcHandlers.length) { groups.splice(Math.min(g, groups.length), 0, fresh()); continue; }
      const at = groups[g];
      if (isRecord(at) && Array.isArray((at as JsonObject).hooks) && ((at as JsonObject).matcher ?? null) === (src.matcher ?? null)) {
        const next = [...((at as JsonObject).hooks as Json[])];
        for (const h of missing) next.splice(Math.min(h, next.length), 0, srcHandlers[h]!);
        groups[g] = { ...(at as JsonObject), hooks: next };
      } else groups.splice(Math.min(g, groups.length), 0, fresh());
    }
    hooks[event] = groups;
  }
  if (!changed) return target;
  const sourceOrder = isRecord(source.hooks) ? Object.keys(source.hooks as JsonObject) : [];
  const order = [...sourceOrder.filter((k) => k in hooks), ...Object.keys(hooks).filter((k) => !sourceOrder.includes(k))];
  return { ...target, hooks: Object.fromEntries(order.map((k) => [k, hooks[k]!])) };
}

export function findHandler(file: JsonObject, desired: DesiredHook): HookPosition | null {
  const groups = groupsOf(file, desired.event);
  for (let g = 0; g < groups.length; g += 1) {
    const handlers = handlersOf(groups[g]!);
    for (let h = 0; h < handlers.length; h += 1) {
      if (JSON.stringify(handlers[h]) === JSON.stringify(desired.handler)) return { event: desired.event, group: g, handler: h };
    }
  }
  return null;
}

// ---------- codex trust ----------

/** Codex's hook_event_key_label: SessionStart → session_start. */
export const codexEventLabel = (event: string) => event.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** codex-rs hooks::hook_key: `<hooks.json path>:<event label>:<group>:<handler>`. */
export const codexHookKey = (hooksPath: string, at: HookPosition) =>
  `${hooksPath}:${codexEventLabel(at.event)}:${at.group}:${at.handler}`;

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, sortKeys(value[k])]));
  return value;
}

/**
 * Codex's trusted_hash for one command hook (codex-rs 0.169, hooks/src/engine/discovery.rs
 * `hook_hash` + config/src/fingerprint.rs `version_for_toml`): sha256 of the
 * key-sorted compact JSON of the normalized identity
 * `{ event_name, matcher?, hooks: [{ type, command, timeout, async, statusMessage? }] }`.
 * A missing timeout normalizes to 600 s; `None` fields vanish in the TOML round trip.
 */
export function codexTrustHash(desired: DesiredHook): string {
  const { handler } = desired;
  const normalized: Record<string, unknown> = {
    type: "command",
    command: handler.command,
    timeout: Math.max(1, handler.timeout ?? 600),
    async: false,
  };
  if (handler.statusMessage !== undefined) normalized.statusMessage = handler.statusMessage;
  const identity: Record<string, unknown> = { event_name: codexEventLabel(desired.event), hooks: [normalized] };
  if (desired.matcher !== undefined) identity.matcher = desired.matcher;
  return `sha256:${createHash("sha256").update(JSON.stringify(sortKeys(identity))).digest("hex")}`;
}

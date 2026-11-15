// Host-side harness operations. Pure functions of explicit paths: the host
// entry passes the real home and plugin data dir, tests pass temp dirs. Nothing
// here reads os.homedir() or process.env.
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessState } from "../contract.js";
import { HOOK_MJS, HOOK_SH } from "./hook-assets.js";
import {
  codexHookKey, codexTrustHash, ensureHook, findHandler, hasHook, isCodexHonchoCommand, isOwnCommand,
  removeHandlers, type DesiredHook, type Json, type JsonObject,
} from "./hooks-json.js";
import { applyChanges, exists, listBackups, markRestored, readText, removeFile, restoreBackup, saveBackup, writeAtomic, writeChanges, type Change } from "./files.js";
import { hasHonchoMcp, readHookStates, rekeyHookStates, setHookTrust, stripHonchoMcp } from "./toml.js";
import { isRecord } from "./schema.js";

export interface HarnessPaths {
  /** Claude Code's config dir (`$CLAUDE_CONFIG_DIR` or ~/.claude). */
  claudeDir: string;
  /** Codex's home (`$CODEX_HOME` or ~/.codex). */
  codexDir: string;
  /** This plugin's persistent data dir on the host. */
  dataDir: string;
}

export function resolveHarnessPaths(args: { home: string; dataDir: string; env?: Record<string, string | undefined> }): HarnessPaths {
  const env = args.env ?? {};
  return {
    claudeDir: env.CLAUDE_CONFIG_DIR || join(args.home, ".claude"),
    codexDir: env.CODEX_HOME || join(args.home, ".codex"),
    dataDir: args.dataDir,
  };
}

export const CLAUDE_PLUGIN_ID = "honcho@honcho";
export const HONCHO_MCP_MATCHER = "mcp__plugin_honcho_honcho__.*";
const HOOK_TIMEOUT_S = 10;

export function layout(paths: HarnessPaths) {
  const bbDir = join(paths.dataDir, "harness");
  const hookDir = join(bbDir, "hooks");
  return {
    bbDir,
    hookDir,
    hookSh: join(hookDir, "bb-honcho-hook.sh"),
    hookMjs: join(hookDir, "bb-honcho-hook.mjs"),
    backupsDir: join(bbDir, "backups"),
    /** Deliberately never created: claude-honcho then finds no credential. */
    claudeDisabledConfig: join(bbDir, "claude-honcho-disabled.json"),
    codexHonchoDir: join(bbDir, "codex-honcho"),
    recallDir: join(paths.dataDir, "recall"),
    claudeSettings: join(paths.claudeDir, "settings.json"),
    claudeInstalledPlugins: join(paths.claudeDir, "plugins", "installed_plugins.json"),
    claudePluginCache: join(paths.claudeDir, "plugins", "cache", "honcho", "honcho"),
    codexHooks: join(paths.codexDir, "hooks.json"),
    codexConfig: join(paths.codexDir, "config.toml"),
  };
}

const shQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function desiredHooks(paths: HarnessPaths) {
  const { hookSh } = layout(paths);
  const command = (mode: string) => `sh ${shQuote(hookSh)} ${mode}`;
  const prompt: DesiredHook = { event: "UserPromptSubmit", handler: { type: "command", command: command("prompt"), timeout: HOOK_TIMEOUT_S } };
  const pretool: DesiredHook = { event: "PreToolUse", matcher: HONCHO_MCP_MATCHER, handler: { type: "command", command: command("pretool"), timeout: HOOK_TIMEOUT_S } };
  return { claude: [prompt, pretool], codex: [prompt] };
}

// ---------- reading ----------

/** Refuses to edit a file it cannot parse, rather than overwrite it. */
function parseObject(text: string | null, label: string): JsonObject {
  if (text === null || text.trim() === "") return {};
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${label} is not valid JSON; not editing it`); }
  if (!isRecord(parsed)) throw new Error(`${label} is not a JSON object; not editing it`);
  return parsed as JsonObject;
}

const serialize = (value: JsonObject) => JSON.stringify(value, null, 2) + "\n";

async function hookFilesCurrent(paths: HarnessPaths): Promise<boolean> {
  const l = layout(paths);
  return (await readText(l.hookSh)) === HOOK_SH && (await readText(l.hookMjs)) === HOOK_MJS;
}

/** Writes the bb-owned hook copies (no backup: bb owns this dir). */
export async function installHookFiles(paths: HarnessPaths): Promise<void> {
  const l = layout(paths);
  await mkdir(l.hookDir, { recursive: true });
  if ((await readText(l.hookMjs)) !== HOOK_MJS) await writeAtomic(l.hookMjs, HOOK_MJS, 0o644);
  if ((await readText(l.hookSh)) !== HOOK_SH) await writeAtomic(l.hookSh, HOOK_SH, 0o755);
  await chmod(l.hookSh, 0o755);
}

async function claudePluginVersion(paths: HarnessPaths): Promise<string | null> {
  const l = layout(paths);
  try {
    const installed = JSON.parse((await readText(l.claudeInstalledPlugins)) ?? "{}") as { plugins?: Record<string, unknown> };
    const entries = installed.plugins?.[CLAUDE_PLUGIN_ID];
    if (Array.isArray(entries)) {
      const versions = entries.map((e) => (isRecord(e) && typeof e.version === "string" ? e.version : null)).filter(Boolean) as string[];
      if (versions.length) return versions[0]!;
    }
  } catch { /* fall back to the cache dir */ }
  try {
    const dirs = (await readdir(l.claudePluginCache)).filter((d) => /^\d+\.\d+/.test(d));
    const num = (v: string) => v.split(/[.-]/).map((p) => Number.parseInt(p, 10) || 0);
    dirs.sort((a, b) => { const x = num(a), y = num(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; } return 0; });
    return dirs.at(-1) ?? null;
  } catch { return null; }
}

function hasCodexHonchoHooks(file: JsonObject): boolean {
  return removeHandlers(file, (h) => isRecord(h) && isCodexHonchoCommand((h as JsonObject).command)).removed.length > 0;
}

export type HostHarnessState = Omit<HarnessState, "machineId">;

export async function harnessState(paths: HarnessPaths): Promise<HostHarnessState> {
  const l = layout(paths);
  const desired = desiredHooks(paths);
  const filesOk = await hookFilesCurrent(paths);

  let claudeSettings: JsonObject = {};
  try { claudeSettings = parseObject(await readText(l.claudeSettings), "settings.json"); } catch { claudeSettings = {}; }
  const pluginVersion = await claudePluginVersion(paths);
  const enabled = isRecord(claudeSettings.enabledPlugins) ? (claudeSettings.enabledPlugins as JsonObject)[CLAUDE_PLUGIN_ID] : undefined;

  let codexHooks: JsonObject = {};
  try { codexHooks = parseObject(await readText(l.codexHooks), "hooks.json"); } catch { codexHooks = {}; }
  const toml = (await readText(l.codexConfig)) ?? "";
  const codexHookInstalled = filesOk && desired.codex.every((d) => hasHook(codexHooks, d));
  let trusted: boolean | null = false;
  if (codexHookInstalled) {
    const { states, unsupported } = readHookStates(toml);
    trusted = desired.codex.every((d) => {
      const at = findHandler(codexHooks, d);
      return !!at && states.get(codexHookKey(l.codexHooks, at))?.trustedHash === codexTrustHash(d);
    });
    if (!trusted && unsupported) trusted = null;
  }

  return {
    claude: {
      hookInstalled: filesOk && desired.claude.every((d) => hasHook(claudeSettings, d)),
      handedOver: pluginVersion === null || enabled === false,
      pluginVersion,
    },
    codex: {
      hookInstalled: codexHookInstalled,
      handedOver: !hasCodexHonchoHooks(codexHooks) && !hasHonchoMcp(toml),
      trusted,
    },
    backups: (await listBackups(l.backupsDir)).map((b) => b.name),
  };
}

// ---------- env paths ----------

export interface EnvPaths { claudeConfigPath: string; codexConfigDir: string; recallDir: string }

/**
 * Prepares this host for a bb-run harness: a codex-honcho config dir with
 * `enabled:false` and no key, the claude-honcho config path kept nonexistent,
 * and current copies of the hook if it was installed.
 */
export async function prepareEnv(paths: HarnessPaths): Promise<EnvPaths> {
  const l = layout(paths);
  const codexConfig = join(l.codexHonchoDir, "config.json");
  const wanted = JSON.stringify({ enabled: false }, null, 2) + "\n";
  if ((await readText(codexConfig)) !== wanted) {
    await mkdir(l.codexHonchoDir, { recursive: true, mode: 0o700 });
    await writeAtomic(codexConfig, wanted, 0o600);
  }
  await removeFile(l.claudeDisabledConfig);
  if (await exists(l.hookDir)) await installHookFiles(paths);
  return { claudeConfigPath: l.claudeDisabledConfig, codexConfigDir: l.codexHonchoDir, recallDir: l.recallDir };
}

// ---------- connect / hand over / undo ----------

async function change(path: string, edit: (before: string | null) => string | null): Promise<Change> {
  const before = await readText(path);
  return { path, before, after: edit(before) };
}

export async function connect(paths: HarnessPaths): Promise<{ backup: string | null; codexTrustError?: string }> {
  const l = layout(paths);
  const desired = desiredHooks(paths);
  await installHookFiles(paths);
  const changes: Change[] = [];
  let codexTrustError: string | undefined;

  if (await exists(paths.claudeDir)) {
    changes.push(await change(l.claudeSettings, (before) => {
      let file = parseObject(before, "settings.json");
      for (const d of desired.claude) file = ensureHook(file, d);
      const after = serialize(file);
      return before !== null && JSON.stringify(parseObject(before, "settings.json")) === JSON.stringify(file) ? before : after;
    }));
  }

  if (await exists(paths.codexDir)) {
    const hooksChange = await change(l.codexHooks, (before) => {
      let file = parseObject(before, "hooks.json");
      for (const d of desired.codex) file = ensureHook(file, d);
      return before !== null && JSON.stringify(parseObject(before, "hooks.json")) === JSON.stringify(file) ? before : serialize(file);
    });
    changes.push(hooksChange);
    const hooksAfter = parseObject(hooksChange.after, "hooks.json");
    changes.push(await change(l.codexConfig, (before) => {
      let toml = before ?? "";
      const mapping = new Map<string, string | null>();
      // Replacing a stale copy of our hook can shift later handlers in the event; keep their trust.
      if (hooksChange.before !== hooksChange.after) {
        for (const [from, to] of rekeyAfterEdit(parseObject(hooksChange.before, "hooks.json"), hooksAfter, l.codexHooks)) mapping.set(from, to);
      }
      if (mapping.size) toml = rekeyHookStates(toml, mapping);
      for (const d of desired.codex) {
        const at = findHandler(hooksAfter, d);
        if (!at) continue;
        try { toml = setHookTrust(toml, codexHookKey(l.codexHooks, at), codexTrustHash(d)); }
        catch (error) { codexTrustError = (error as Error).message; }
      }
      return before === null && toml === "" ? null : toml;
    }));
  }

  const backup = await applyChanges(l.backupsDir, "connect", changes);
  return codexTrustError ? { backup, codexTrustError } : { backup };
}

/**
 * Old → new trust keys for handlers that survive an edit unchanged. A handler is
 * matched by identical JSON, in order, so duplicates pair up first-come.
 */
function rekeyAfterEdit(before: JsonObject, after: JsonObject, hooksPath: string): Map<string, string | null> {
  const list = (file: JsonObject) => removeHandlers(file, () => false).moved.map((m) => m.from);
  const handlerAt = (file: JsonObject, at: { event: string; group: number; handler: number }): Json => {
    const groups = (file.hooks as JsonObject)[at.event] as Json[];
    return ((groups[at.group] as JsonObject).hooks as Json[])[at.handler]!;
  };
  const remaining = list(after).map((at) => ({ at, json: JSON.stringify(handlerAt(after, at)), used: false }));
  const mapping = new Map<string, string | null>();
  for (const at of list(before)) {
    const json = JSON.stringify(handlerAt(before, at));
    const match = remaining.find((r) => !r.used && r.at.event === at.event && r.json === json);
    const from = codexHookKey(hooksPath, at);
    if (match) { match.used = true; const to = codexHookKey(hooksPath, match.at); if (to !== from) mapping.set(from, to); }
    else mapping.set(from, null);
  }
  return mapping;
}

export async function handOver(paths: HarnessPaths): Promise<{ backup: string | null }> {
  const l = layout(paths);
  const changes: Change[] = [];

  if (await exists(paths.claudeDir)) {
    changes.push(await change(l.claudeSettings, (before) => {
      const file = parseObject(before, "settings.json");
      const plugins = isRecord(file.enabledPlugins) ? (file.enabledPlugins as JsonObject) : {};
      if (plugins[CLAUDE_PLUGIN_ID] === false) return before;
      return serialize({ ...file, enabledPlugins: { ...plugins, [CLAUDE_PLUGIN_ID]: false } });
    }));
  }

  if (await exists(paths.codexDir)) {
    const hooksBefore = await readText(l.codexHooks);
    let mapping = new Map<string, string | null>();
    if (hooksBefore !== null) {
      const file = parseObject(hooksBefore, "hooks.json");
      const result = removeHandlers(file, (h) => isRecord(h) && isCodexHonchoCommand((h as JsonObject).command));
      if (result.removed.length) {
        changes.push({ path: l.codexHooks, before: hooksBefore, after: serialize(result.file) });
        mapping = new Map<string, string | null>();
        for (const at of result.removed) mapping.set(codexHookKey(l.codexHooks, at), null);
        for (const { from, to } of result.moved) {
          const a = codexHookKey(l.codexHooks, from), b = codexHookKey(l.codexHooks, to);
          if (a !== b) mapping.set(a, b);
        }
      }
    }
    changes.push(await change(l.codexConfig, (before) => {
      if (before === null) return null;
      let toml = stripHonchoMcp(before);
      if (mapping.size) toml = rekeyHookStates(toml, mapping);
      return toml;
    }));
  }

  return { backup: await applyChanges(l.backupsDir, "handover", changes) };
}

// ---------- undo ----------

export type UndoStep = "connect" | "handOver";
const OP: Record<UndoStep, string> = { connect: "connect", handOver: "handover" };

/** Removes our hooks from both harnesses and drops (or re-keys) their codex trust. */
async function disconnectChanges(paths: HarnessPaths): Promise<Change[]> {
  const l = layout(paths);
  const own = (h: Json) => isRecord(h) && isOwnCommand((h as JsonObject).command);
  const changes: Change[] = [];
  const settings = await readText(l.claudeSettings);
  if (settings !== null) {
    const result = removeHandlers(parseObject(settings, "settings.json"), own);
    if (result.removed.length) changes.push({ path: l.claudeSettings, before: settings, after: serialize(result.file) });
  }
  const hooks = await readText(l.codexHooks);
  if (hooks !== null) {
    const result = removeHandlers(parseObject(hooks, "hooks.json"), own);
    if (result.removed.length) {
      changes.push({ path: l.codexHooks, before: hooks, after: serialize(result.file) });
      const mapping = new Map<string, string | null>();
      for (const at of result.removed) mapping.set(codexHookKey(l.codexHooks, at), null);
      for (const { from, to } of result.moved) {
        const a = codexHookKey(l.codexHooks, from), b = codexHookKey(l.codexHooks, to);
        if (a !== b) mapping.set(a, b);
      }
      const toml = await readText(l.codexConfig);
      if (toml !== null) changes.push({ path: l.codexConfig, before: toml, after: rekeyHookStates(toml, mapping) });
    }
  }
  return changes;
}

/**
 * Undoes one step, or with no step everything bb changed.
 *
 * Backup sets form a chain, so the newest live set can always be restored byte
 * for byte. A step whose set is older than the other step's is undone by
 * restoring its set and then re-establishing the other step's current state
 * (re-connecting, or removing our hooks again), which retires the newer sets.
 * The state being replaced is always saved first as an `undo` set.
 */
export async function undo(paths: HarnessPaths, step?: UndoStep): Promise<{ restored: string[] }> {
  const l = layout(paths);
  const live = async () => (await listBackups(l.backupsDir)).filter((s) => s.manifest.op !== "undo" && !s.manifest.restoredAt);
  const sets = await live();
  const wanted = step ? sets.filter((s) => s.manifest.op === OP[step]) : sets;
  if (!wanted.length && step !== "connect") return { restored: [] };
  const before = await harnessState(paths);
  const wasConnected = before.claude.hookInstalled || before.codex.hookInstalled;
  if (!wanted.length && !wasConnected) return { restored: [] };
  await saveBackup(l.backupsDir, "undo", [l.claudeSettings, l.codexHooks, l.codexConfig]);
  const restored: string[] = [];

  if (!step) {
    for (const set of sets) { await restoreBackup(l.backupsDir, set.name); restored.push(set.name); }
    if (wasConnected) await writeChanges(await disconnectChanges(paths));
    return { restored };
  }

  if (step === "connect") {
    // Peel connect sets off the top of the chain while they are the newest.
    for (const set of sets) {
      if (set.manifest.op !== "connect") break;
      await restoreBackup(l.backupsDir, set.name);
      restored.push(set.name);
    }
    await writeChanges(await disconnectChanges(paths));
    for (const set of await live()) if (set.manifest.op === "connect") { await markRestored(l.backupsDir, set.name); restored.push(set.name); }
    return { restored };
  }

  // handOver: restore its newest set; sets newer than it described files that no longer exist.
  const target = wanted[0]!;
  for (const set of sets) {
    if (set.name === target.name) break;
    await markRestored(l.backupsDir, set.name);
  }
  await restoreBackup(l.backupsDir, target.name);
  restored.push(target.name);
  const after = await harnessState(paths);
  if (wasConnected && !(after.claude.hookInstalled && after.codex.hookInstalled)) await connect(paths);
  else if (!wasConnected && (after.claude.hookInstalled || after.codex.hookInstalled)) await writeChanges(await disconnectChanges(paths));
  return { restored };
}

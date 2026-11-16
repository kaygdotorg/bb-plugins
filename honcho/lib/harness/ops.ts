// Host-side harness operations. Pure functions of explicit paths: the host
// entry passes the real home and plugin data dir, tests pass temp dirs. Nothing
// here reads os.homedir() or process.env.
import { chmod, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { HarnessState } from "../contract.js";
import { HOOK_MJS, HOOK_SH } from "./hook-assets.js";
import {
  codexHookKey, codexTrustHash, ensureHook, findHandler, handlerAt, hasHook, isCodexHonchoCommand, isOwnCommand,
  locateHandler, reinsertHandlers, removeHandlers, type DesiredHook, type HookPosition, type Json, type JsonObject,
} from "./hooks-json.js";
import {
  commitChanges, ConflictError, exists, listBackups, loadSet, readText, removeFile, removeSet, restoreMoved, saveSet, updateSet, writeAtomic,
  type Change, type SetFile,
} from "./files.js";
import { appendHonchoMcp, extractHonchoMcp, hasHonchoMcp, readHookStates, rekeyHookStates, setHookTrust, stripHonchoMcp } from "./toml.js";
import { lstat } from "node:fs/promises";
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
    /** codex-honcho's skill: it tells agents its hooks inject and record, which stops being true after hand over. */
    codexHonchoSkill: join(paths.codexDir, "skills", "honcho-memory"),
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
      handedOver: !hasCodexHonchoHooks(codexHooks) && !hasHonchoMcp(toml) && !(await lexists(l.codexHonchoSkill)),
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
//
// Every step reads the three user files once, computes its edit from exactly
// those bytes, saves them (before and after) as a backup set, and writes with a
// compare-and-swap. A file that changes underneath restarts the whole step.

type FileKey = "settings" | "hooks" | "toml";
type Files = Record<FileKey, string | null>;
const FILE_KEYS: FileKey[] = ["settings", "hooks", "toml"];

function filePaths(l: ReturnType<typeof layout>): Record<FileKey, string> {
  return { settings: l.claudeSettings, hooks: l.codexHooks, toml: l.codexConfig };
}

async function readFiles(l: ReturnType<typeof layout>): Promise<Files> {
  const p = filePaths(l);
  return { settings: await readText(p.settings), hooks: await readText(p.hooks), toml: await readText(p.toml) };
}

const sameFiles = (a: Files, b: Files) => FILE_KEYS.every((k) => a[k] === b[k]);

/** The first try plus up to three retries. */
const ATTEMPTS = 4;

async function retrying<T>(label: string, run: () => Promise<T>): Promise<T> {
  let conflict: ConflictError | undefined;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    try { return await run(); } catch (error) {
      if (!(error instanceof ConflictError)) throw error;
      conflict = error;
    }
  }
  throw new Error(`${label} gave up: ${conflict!.path} kept changing while bb edited it (${ATTEMPTS} tries); no file was changed`);
}

const lexists = async (path: string) => { try { await lstat(path); return true; } catch { return false; } };

/** Backs up `before`→`after` and writes the difference, or rolls everything back. `moveDirs` are moved into the set. */
async function commitStep(l: ReturnType<typeof layout>, op: string, before: Files, after: Files, moveDirs: string[] = []): Promise<string | null> {
  if (sameFiles(before, after) && !moveDirs.length) return null;
  const p = filePaths(l);
  const name = await saveSet(l.backupsDir, op, FILE_KEYS.map((key) => ({ key, path: p[key], before: before[key], after: after[key] })), Date.now(), moveDirs);
  const changes: Change[] = FILE_KEYS.map((key) => ({ path: p[key], before: before[key], after: after[key] }));
  try { await commitChanges(changes); } catch (error) { await removeSet(l.backupsDir, name); throw error; }
  return name;
}

/** The hooks.json edit plus the codex trust re-keying that keeps the other hooks trusted. */
function moveMapping(result: ReturnType<typeof removeHandlers>, hooksPath: string): Map<string, string | null> {
  const mapping = new Map<string, string | null>();
  for (const at of result.removed) mapping.set(codexHookKey(hooksPath, at), null);
  for (const { from, to } of result.moved) {
    const a = codexHookKey(hooksPath, from), b = codexHookKey(hooksPath, to);
    if (a !== b) mapping.set(a, b);
  }
  return mapping;
}

export async function connect(paths: HarnessPaths): Promise<{ backup: string | null; codexTrustError?: string }> {
  const l = layout(paths);
  const desired = desiredHooks(paths);
  await installHookFiles(paths);
  return retrying("connect", async () => {
    const before = await readFiles(l);
    const after = { ...before };
    let codexTrustError: string | undefined;

    if (await exists(paths.claudeDir)) {
      let file = parseObject(before.settings, "settings.json");
      for (const d of desired.claude) file = ensureHook(file, d);
      const unchanged = before.settings !== null && JSON.stringify(parseObject(before.settings, "settings.json")) === JSON.stringify(file);
      after.settings = unchanged ? before.settings : serialize(file);
    }

    if (await exists(paths.codexDir)) {
      const hooksBefore = parseObject(before.hooks, "hooks.json");
      let hooksAfter = hooksBefore;
      for (const d of desired.codex) hooksAfter = ensureHook(hooksAfter, d);
      const unchanged = before.hooks !== null && JSON.stringify(hooksBefore) === JSON.stringify(hooksAfter);
      after.hooks = unchanged ? before.hooks : serialize(hooksAfter);
      let toml = before.toml ?? "";
      // Replacing a stale copy of our hook can shift later handlers in the event; keep their trust.
      if (after.hooks !== before.hooks) {
        const mapping = rekeyAfterEdit(hooksBefore, hooksAfter, l.codexHooks);
        if (mapping.size) toml = rekeyHookStates(toml, mapping);
      }
      for (const d of desired.codex) {
        const at = findHandler(hooksAfter, d);
        if (!at) continue;
        try { toml = setHookTrust(toml, codexHookKey(l.codexHooks, at), codexTrustHash(d)); }
        catch (error) { codexTrustError = (error as Error).message; }
      }
      after.toml = before.toml === null && toml === "" ? null : toml;
    }

    const backup = await commitStep(l, "connect", before, after);
    return codexTrustError ? { backup, codexTrustError } : { backup };
  });
}

/**
 * Old → new trust keys for handlers that survive an edit unchanged. A handler is
 * matched by identical JSON, in order, so duplicates pair up first-come.
 */
function rekeyAfterEdit(before: JsonObject, after: JsonObject, hooksPath: string): Map<string, string | null> {
  const list = (file: JsonObject) => removeHandlers(file, () => false).moved.map((m) => m.from);
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

const isCodexHoncho = (h: Json) => isRecord(h) && isCodexHonchoCommand((h as JsonObject).command);

export async function handOver(paths: HarnessPaths): Promise<{ backup: string | null }> {
  const l = layout(paths);
  return retrying("hand over", async () => {
    const before = await readFiles(l);
    const after = { ...before };

    if (await exists(paths.claudeDir)) {
      const file = parseObject(before.settings, "settings.json");
      const plugins = isRecord(file.enabledPlugins) ? (file.enabledPlugins as JsonObject) : {};
      if (plugins[CLAUDE_PLUGIN_ID] !== false) after.settings = serialize({ ...file, enabledPlugins: { ...plugins, [CLAUDE_PLUGIN_ID]: false } });
    }

    if (await exists(paths.codexDir)) {
      let mapping = new Map<string, string | null>();
      if (before.hooks !== null) {
        const result = removeHandlers(parseObject(before.hooks, "hooks.json"), isCodexHoncho);
        if (result.removed.length) {
          after.hooks = serialize(result.file);
          mapping = moveMapping(result, l.codexHooks);
        }
      }
      if (before.toml !== null) {
        let toml = stripHonchoMcp(before.toml);
        if (mapping.size) toml = rekeyHookStates(toml, mapping);
        after.toml = toml;
      }
    }

    const skill = (await exists(paths.codexDir)) && (await lexists(l.codexHonchoSkill)) ? [l.codexHonchoSkill] : [];
    return { backup: await commitStep(l, "handover", before, after, skill) };
  });
}

// ---------- undo ----------

export type UndoStep = "connect" | "handOver";
const OP: Record<UndoStep, string> = { connect: "connect", handOver: "handover" };

interface LiveSet { name: string; op: string; before: Files; after: Files }

/** Live connect and handover sets for the current files, newest first. */
async function liveSets(l: ReturnType<typeof layout>): Promise<LiveSet[]> {
  const p = filePaths(l);
  const sets: LiveSet[] = [];
  for (const { name, manifest } of await listBackups(l.backupsDir)) {
    if (manifest.op === "undo" || manifest.restoredAt) continue;
    const { files } = await loadSet(l.backupsDir, name);
    const before = {} as Files, after = {} as Files;
    let ok = true;
    for (const key of FILE_KEYS) {
      const file = files.find((f) => f.key === key);
      if (!file || file.path !== p[key]) { ok = false; break; }
      before[key] = file.before; after[key] = file.after;
    }
    if (ok) sets.push({ name, op: manifest.op, before, after });
  }
  return sets;
}

interface Scope { claude: boolean; codex: boolean }

/** Removes bb's own hooks, re-keying the codex trust of the hooks that move. */
function revertConnect(l: ReturnType<typeof layout>, files: Files, scope: Scope, lenient = false): Files {
  const out = { ...files };
  const own = (h: Json) => isRecord(h) && isOwnCommand((h as JsonObject).command);
  const parse = (text: string, label: string) => {
    try { return parseObject(text, label); } catch (error) { if (lenient) return null; throw error; }
  };
  if (scope.claude && files.settings !== null) {
    const file = parse(files.settings, "settings.json");
    const result = file && removeHandlers(file, own);
    if (result?.removed.length) out.settings = serialize(result.file);
  }
  if (scope.codex && files.hooks !== null) {
    const file = parse(files.hooks, "hooks.json");
    const result = file && removeHandlers(file, own);
    if (result?.removed.length) {
      out.hooks = serialize(result.file);
      if (files.toml !== null) out.toml = rekeyHookStates(files.toml, moveMapping(result, l.codexHooks));
    }
  }
  return out;
}

/**
 * Reverts one hand over on files that changed since: claude-honcho's enabled
 * flag goes back to its prior value (or away), and codex-honcho's hooks, their
 * trust and its MCP tables go back in as they were in `prior`. Everything else
 * in the files stays.
 */
function revertHandOver(l: ReturnType<typeof layout>, prior: Files, files: Files, scope: Scope): Files {
  const out = { ...files };
  if (scope.claude && files.settings !== null) {
    const file = parseObject(files.settings, "settings.json");
    const plugins = isRecord(file.enabledPlugins) ? (file.enabledPlugins as JsonObject) : null;
    if (plugins && plugins[CLAUDE_PLUGIN_ID] === false) {
      const priorFile = parseObject(prior.settings, "settings.json");
      const priorPlugins = isRecord(priorFile.enabledPlugins) ? (priorFile.enabledPlugins as JsonObject) : null;
      const nextPlugins: JsonObject = { ...plugins };
      if (priorPlugins && CLAUDE_PLUGIN_ID in priorPlugins) nextPlugins[CLAUDE_PLUGIN_ID] = priorPlugins[CLAUDE_PLUGIN_ID]!;
      else delete nextPlugins[CLAUDE_PLUGIN_ID];
      const next: JsonObject = { ...file, enabledPlugins: nextPlugins };
      if (!priorPlugins && Object.keys(nextPlugins).length === 0) delete next.enabledPlugins;
      out.settings = serialize(next);
    }
  }
  if (scope.codex) {
    const source = parseObject(prior.hooks, "hooks.json");
    const removed: HookPosition[] = removeHandlers(source, isCodexHoncho).removed;
    const hooksNow = files.hooks === null ? null : parseObject(files.hooks, "hooks.json");
    const hooksNext = hooksNow && removed.length ? reinsertHandlers(hooksNow, source, removed) : hooksNow;
    if (hooksNext !== hooksNow) out.hooks = serialize(hooksNext!);
    if (files.toml !== null) {
      let toml = files.toml;
      if (hooksNow && hooksNext !== hooksNow) {
        const mapping = rekeyAfterEdit(hooksNow, hooksNext!, l.codexHooks);
        if (mapping.size) toml = rekeyHookStates(toml, mapping);
      }
      if (hooksNext) {
        const priorStates = readHookStates(prior.toml ?? "").states;
        for (const at of removed) {
          const hash = priorStates.get(codexHookKey(l.codexHooks, at))?.trustedHash;
          const now = hash ? locateHandler(hooksNext, at.event, handlerAt(source, at)) : null;
          if (!hash || !now) continue;
          const key = codexHookKey(l.codexHooks, now);
          if (readHookStates(toml).states.get(key)?.trustedHash === hash) continue;
          try { toml = setHookTrust(toml, key, hash); } catch { /* a hooks.state shape bb does not edit: codex asks again */ }
        }
      }
      const mcp = extractHonchoMcp(prior.toml ?? "");
      if (mcp && !hasHonchoMcp(toml)) toml = appendHonchoMcp(toml, mcp);
      out.toml = toml;
    }
  }
  return out;
}

/**
 * Undoes set `set` on `files`. A file that still holds exactly what the step
 * wrote gets its backed-up bytes back (which may mean removing a file the step
 * created); a file that changed since only loses the step's own edits.
 */
function undoSet(l: ReturnType<typeof layout>, set: LiveSet, files: Files): Files {
  const touched = (k: FileKey) => set.before[k] !== set.after[k];
  const scope: Scope = { claude: touched("settings"), codex: touched("hooks") || touched("toml") };
  const inScope = (k: FileKey) => (k === "settings" ? scope.claude : scope.codex);
  let surgical: Files | null = null;
  if (FILE_KEYS.some((k) => inScope(k) && files[k] !== set.after[k])) {
    surgical = set.op === "connect" ? revertConnect(l, files, scope) : revertHandOver(l, set.before, files, scope);
  }
  const out = { ...files };
  for (const k of FILE_KEYS) {
    if (!inScope(k)) continue;
    out[k] = files[k] === set.after[k] ? set.before[k] : surgical![k];
  }
  return out;
}

const toSetFiles = (l: ReturnType<typeof layout>, set: LiveSet): SetFile[] =>
  FILE_KEYS.map((key) => ({ key, path: filePaths(l)[key], before: set.before[key], after: set.after[key] }));

/**
 * Undoes one step, or with no step everything bb changed.
 *
 * Each undone set is reverted on the live files (see undoSet). Sets newer than
 * it are rebased: the same revert is applied to their stored before and after,
 * so a later undo of those still sees its own after on unchanged files and
 * lands on the right bytes. Undoing connect undoes every connect set and then
 * removes any of bb's hooks left over; undoing hand over undoes the newest one.
 * The replaced state is saved first as an `undo` set.
 */
export async function undo(paths: HarnessPaths, step?: UndoStep): Promise<{ restored: string[]; kept?: string[] }> {
  const l = layout(paths);
  return retrying("undo", async () => {
    const sets = await liveSets(l);
    const targets = !step ? sets : step === "connect" ? sets.filter((s) => s.op === OP.connect) : sets.filter((s) => s.op === OP.handOver).slice(0, 1);
    const sweep = step === "connect" || (!step && targets.length > 0);
    if (!targets.length && !sweep) return { restored: [] };

    const live = await readFiles(l);
    let files = live;
    const undone = new Set<string>();
    const rebased = new Set<string>();
    for (const target of targets) {
      files = undoSet(l, target, files);
      for (const newer of sets) {
        if (newer.name <= target.name || undone.has(newer.name) || newer === target) continue;
        newer.before = undoSet(l, target, newer.before);
        newer.after = undoSet(l, target, newer.after);
        rebased.add(newer.name);
      }
      undone.add(target.name);
    }
    if (sweep) files = revertConnect(l, files, { claude: true, codex: true }, true);

    if (!sameFiles(live, files)) {
      const p = filePaths(l);
      const name = await saveSet(l.backupsDir, "undo", FILE_KEYS.map((key) => ({ key, path: p[key], before: live[key], after: files[key] })));
      try { await commitChanges(FILE_KEYS.map((key) => ({ path: p[key], before: live[key], after: files[key] }))); }
      catch (error) { await removeSet(l.backupsDir, name); throw error; }
    }
    const now = Date.now();
    const kept: string[] = [];
    for (const target of targets) kept.push(...(await restoreMoved(l.backupsDir, target.name)).kept);
    for (const set of sets) {
      if (undone.has(set.name)) await updateSet(l.backupsDir, set.name, { restoredAt: now });
      else if (rebased.has(set.name)) await updateSet(l.backupsDir, set.name, { files: toSetFiles(l, set) });
    }
    return kept.length ? { restored: targets.map((t) => t.name), kept } : { restored: targets.map((t) => t.name) };
  });
}

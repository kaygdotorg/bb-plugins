// Small filesystem helpers for harness config edits: atomic writes that keep
// the file's mode and follow symlinks (dotfile managers), and backup sets.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const errno = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;

export async function readText(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); } catch (error) {
    if (errno(error) === "ENOENT") return null;
    throw error;
  }
}

export async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

/** A file changed between bb reading it and bb replacing it. */
export class ConflictError extends Error {
  constructor(readonly path: string) { super(`${path} changed while bb was editing it`); }
}

/** Test seam: runs right before each compare-and-swap check, to simulate a concurrent writer. */
export const testHooks: { beforeSwap?: (path: string) => void | Promise<void> } = {};

/**
 * Writes through a symlink to its target, atomically, keeping the target's mode.
 * With `expect`, the target is re-read just before the rename and the write is
 * abandoned with a ConflictError unless it still holds exactly `expect`
 * (null: does not exist).
 */
export async function writeAtomic(path: string, text: string | Buffer, mode?: number, expect?: string | null): Promise<void> {
  let target = path;
  try { target = await realpath(path); } catch (error) { if (errno(error) !== "ENOENT") throw error; }
  let keepMode = mode;
  if (keepMode === undefined) {
    try { keepMode = (await stat(target)).mode & 0o7777; } catch { keepMode = undefined; }
  }
  await mkdir(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.bb-honcho-${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, text, { mode: keepMode ?? 0o644 });
    if (keepMode !== undefined) await chmod(tmp, keepMode);
    if (expect !== undefined) {
      await testHooks.beforeSwap?.(path);
      if ((await readText(target)) !== expect) throw new ConflictError(path);
    }
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function removeFile(path: string): Promise<void> {
  try { await unlink(path); } catch (error) { if (errno(error) !== "ENOENT") throw error; }
}

// ---------- compare-and-swap writes ----------

export interface Change { path: string; before: string | null; after: string | null }

async function swap(path: string, expect: string | null, next: string | null, mode?: number): Promise<void> {
  if (next !== null) return writeAtomic(path, next, mode, expect);
  await testHooks.beforeSwap?.(path);
  if ((await readText(path)) !== expect) throw new ConflictError(path);
  await removeFile(path);
}

async function modeOf(path: string): Promise<number | undefined> {
  try { return (await stat(path)).mode & 0o7777; } catch { return undefined; }
}

/**
 * Writes every real change, each only if its file still holds `before`. On a
 * conflict the files already written are put back (unless someone changed them
 * again since) and the ConflictError is rethrown: nothing is half-applied.
 */
export async function commitChanges(changes: Change[]): Promise<void> {
  const real = changes.filter((c) => c.before !== c.after);
  const done: Array<{ change: Change; mode: number | undefined }> = [];
  try {
    for (const change of real) {
      const mode = await modeOf(change.path);
      await swap(change.path, change.before, change.after);
      done.push({ change, mode });
    }
  } catch (error) {
    for (const { change, mode } of done.reverse()) {
      try { await swap(change.path, change.after, change.before, mode); } catch { /* changed again since: theirs wins */ }
    }
    throw error;
  }
}

// ---------- backup sets ----------

/**
 * One file of a set: its content before and after bb's step (null: absent).
 * `key` names the role (settings, hooks, toml) so a set is read back by role.
 */
export interface SetFile { key: string; path: string; before: string | null; after: string | null }
interface ManifestFile { key: string; path: string; before: string | null; after: string | null }
export interface BackupManifest { v: 2; op: string; createdAt: number; files: ManifestFile[]; restoredAt?: number }

const MANIFEST = "manifest.json";

/** Sortable: a sequence number first, so sets made in the same millisecond keep their order. */
async function stamp(backupsDir: string, now: number): Promise<string> {
  let next = 0;
  try {
    for (const name of await readdir(backupsDir)) next = Math.max(next, (Number.parseInt(name.slice(0, 6), 10) || 0) + 1);
  } catch { next = 0; }
  return `${String(next).padStart(6, "0")}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
}

async function writeSetFiles(dir: string, files: SetFile[], manifest: Omit<BackupManifest, "files">): Promise<void> {
  const entries: ManifestFile[] = [];
  for (const [index, file] of files.entries()) {
    const entry: ManifestFile = { key: file.key, path: file.path, before: null, after: null };
    for (const side of ["before", "after"] as const) {
      const content = file[side];
      if (content === null) continue;
      entry[side] = `${index}.${side}`;
      await writeAtomic(join(dir, entry[side]!), content, 0o600);
    }
    entries.push(entry);
  }
  await writeAtomic(join(dir, MANIFEST), JSON.stringify({ ...manifest, files: entries }, null, 2) + "\n", 0o600);
}

/**
 * Saves one backup set from the given contents. The caller passes the very bytes
 * it read and edited, so the backup and the edit can never disagree.
 */
export async function saveSet(backupsDir: string, op: string, files: SetFile[], now = Date.now()): Promise<string> {
  const name = `${await stamp(backupsDir, now)}-${op}`;
  const dir = join(backupsDir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeSetFiles(dir, files, { v: 2, op, createdAt: now });
  return name;
}

export async function loadSet(backupsDir: string, name: string): Promise<{ manifest: BackupManifest; files: SetFile[] }> {
  const dir = join(backupsDir, name);
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as BackupManifest;
  const files: SetFile[] = [];
  for (const entry of manifest.files) {
    const read = async (file: string | null) => (file === null ? null : readFile(join(dir, file), "utf8"));
    files.push({ key: entry.key, path: entry.path, before: await read(entry.before), after: await read(entry.after) });
  }
  return { manifest, files };
}

/** Rewrites a set's contents (after a rebase) and/or retires it. */
export async function updateSet(backupsDir: string, name: string, update: { files?: SetFile[]; restoredAt?: number }): Promise<void> {
  const dir = join(backupsDir, name);
  const current = await loadSet(backupsDir, name);
  const { files: _files, ...rest } = current.manifest;
  const manifest = update.restoredAt === undefined ? rest : { ...rest, restoredAt: update.restoredAt };
  await writeSetFiles(dir, update.files ?? current.files, manifest);
}

/** Drops a set whose step was abandoned before any of its writes stuck. */
export async function removeSet(backupsDir: string, name: string): Promise<void> {
  await rm(join(backupsDir, name), { recursive: true, force: true });
}

/** Sets newest first. Unreadable or older-format sets are skipped. */
export async function listBackups(backupsDir: string): Promise<Array<{ name: string; manifest: BackupManifest }>> {
  let names: string[];
  try { names = await readdir(backupsDir); } catch { return []; }
  const sets: Array<{ name: string; manifest: BackupManifest }> = [];
  for (const name of names.sort().reverse()) {
    try {
      const manifest = JSON.parse(await readFile(join(backupsDir, name, MANIFEST), "utf8")) as BackupManifest;
      if (manifest?.v === 2 && Array.isArray(manifest.files)) sets.push({ name, manifest });
    } catch { /* a half-written set is skipped */ }
  }
  return sets;
}

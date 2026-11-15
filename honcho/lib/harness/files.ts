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

/** Writes through a symlink to its target, atomically, keeping the target's mode. */
export async function writeAtomic(path: string, text: string | Buffer, mode?: number): Promise<void> {
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
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

export async function removeFile(path: string): Promise<void> {
  try { await unlink(path); } catch (error) { if (errno(error) !== "ENOENT") throw error; }
}

// ---------- backup sets ----------

export interface BackupFile { path: string; existed: boolean; name: string; mode: number | null }
export interface BackupManifest { v: 1; op: string; createdAt: number; files: BackupFile[]; restoredAt?: number }
export interface Change { path: string; before: string | null; after: string | null }

const MANIFEST = "manifest.json";

/** Sortable: a sequence number first, so sets made in the same millisecond keep their order. */
async function stamp(backupsDir: string, now: number): Promise<string> {
  let next = 0;
  try {
    for (const name of await readdir(backupsDir)) next = Math.max(next, (Number.parseInt(name.slice(0, 6), 10) || 0) + 1);
  } catch { next = 0; }
  return `${String(next).padStart(6, "0")}-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;
}

/** Saves the current content of every file in `paths` as one backup set; returns its name. */
export async function saveBackup(backupsDir: string, op: string, paths: string[], now = Date.now()): Promise<string> {
  const name = `${await stamp(backupsDir, now)}-${op}`;
  const dir = join(backupsDir, name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const files: BackupFile[] = [];
  for (const [index, path] of paths.entries()) {
    let content: Buffer | null = null;
    try { content = await readFile(path); } catch (error) { if (errno(error) !== "ENOENT") throw error; }
    let mode: number | null = null;
    if (content !== null) {
      try { mode = (await stat(path)).mode & 0o7777; } catch { mode = null; }
      await writeFile(join(dir, `${index}.bak`), content, { mode: 0o600 });
    }
    files.push({ path, existed: content !== null, name: `${index}.bak`, mode });
  }
  const manifest: BackupManifest = { v: 1, op, createdAt: now, files };
  await writeFile(join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return name;
}

export async function listBackups(backupsDir: string): Promise<Array<{ name: string; manifest: BackupManifest }>> {
  let names: string[];
  try { names = await readdir(backupsDir); } catch { return []; }
  const sets: Array<{ name: string; manifest: BackupManifest }> = [];
  for (const name of names.sort().reverse()) {
    try {
      const manifest = JSON.parse(await readFile(join(backupsDir, name, MANIFEST), "utf8")) as BackupManifest;
      if (manifest?.v === 1 && Array.isArray(manifest.files)) sets.push({ name, manifest });
    } catch { /* a half-written set is skipped */ }
  }
  return sets;
}

/** Restores one set byte for byte: files that did not exist are removed again. */
export async function restoreBackup(backupsDir: string, name: string): Promise<void> {
  const dir = join(backupsDir, name);
  const manifest = JSON.parse(await readFile(join(dir, MANIFEST), "utf8")) as BackupManifest;
  for (const file of manifest.files) {
    if (!file.existed) { await removeFile(file.path); continue; }
    const content = await readFile(join(dir, file.name));
    await writeAtomic(file.path, content, file.mode ?? undefined);
  }
  await markRestored(backupsDir, name);
}

/** Retires a set: it was restored, or a later per-step undo made its contents obsolete. */
export async function markRestored(backupsDir: string, name: string): Promise<void> {
  const path = join(backupsDir, name, MANIFEST);
  const manifest = JSON.parse(await readFile(path, "utf8")) as BackupManifest;
  manifest.restoredAt = Date.now();
  await writeFile(path, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
}

/** Writes real changes without a backup set (the caller saved one already). */
export async function writeChanges(changes: Change[]): Promise<void> {
  for (const change of changes) {
    if (change.before === change.after) continue;
    if (change.after === null) await removeFile(change.path);
    else await writeAtomic(change.path, change.after);
  }
}

/** Backs up, then writes, every real change. Returns the backup set name, or null for no change. */
export async function applyChanges(backupsDir: string, op: string, changes: Change[]): Promise<string | null> {
  const real = changes.filter((c) => c.before !== c.after);
  if (real.length === 0) return null;
  const name = await saveBackup(backupsDir, op, real.map((c) => c.path));
  await writeChanges(real);
  return name;
}

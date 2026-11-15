import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

/**
 * Recall cache file format shared with the harness hook (hooks/bb-honcho-hook.mjs).
 * v2 stores a hash of the normalized prompt, never the prompt text itself.
 */
export const RECALL_FILE_VERSION = 2;
export const RECALL_KEEP_ENTRIES = 5;
export const RECALL_TEXT_CHARS = 500;
export const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const PROMPT_HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface RecallEntry { counter: number; hash: string; createdAt: number; memory: string }
export interface RecallFile { v: 2; entries: RecallEntry[] }

/** Trim, collapse whitespace, first 500 chars. The hook normalizes the same way. */
export function normalizePromptText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, RECALL_TEXT_CHARS);
}

/** sha256 hex of the normalized text (utf8). The hook hashes its prompt candidates the same way. */
export function promptHash(normalized: string): string {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function isEntry(value: unknown): value is RecallEntry {
  const e = value as RecallEntry;
  return !!e && typeof e === "object" && Number.isSafeInteger(e.counter) && typeof e.hash === "string"
    && PROMPT_HASH_PATTERN.test(e.hash) && Number.isFinite(e.createdAt) && typeof e.memory === "string";
}

/** A corrupt, foreign or older-version (v1, plaintext) file reads as empty and is overwritten. */
export function parseRecallFile(source: string | null): RecallFile {
  if (!source) return { v: 2, entries: [] };
  try {
    const parsed = JSON.parse(source) as Partial<RecallFile>;
    if (parsed?.v !== RECALL_FILE_VERSION || !Array.isArray(parsed.entries)) return { v: 2, entries: [] };
    return { v: 2, entries: parsed.entries.filter(isEntry) };
  } catch { return { v: 2, entries: [] }; }
}

/** Pure merge: next counter, one entry per hash, newest 5 by counter. */
export function appendEntry(file: RecallFile, entry: { hash: string; memory: string; createdAt: number }): { file: RecallFile; entry: RecallEntry } {
  if (!PROMPT_HASH_PATTERN.test(entry.hash)) throw new Error("Invalid prompt hash.");
  const counter = file.entries.reduce((max, e) => Math.max(max, e.counter), 0) + 1;
  const next: RecallEntry = { counter, hash: entry.hash, createdAt: entry.createdAt, memory: entry.memory };
  // A re-attempted dispatch of the same prompt replaces its older entry.
  const entries = [...file.entries.filter(e => e.hash !== entry.hash), next]
    .sort((a, b) => a.counter - b.counter)
    .slice(-RECALL_KEEP_ENTRIES);
  return { file: { v: 2, entries }, entry: next };
}

export function recallFilePath(dir: string, threadId: string): string {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("Invalid thread id.");
  return join(dir, `${threadId}.json`);
}

/** Read-modify-write with an atomic rename. Callers serialize writes per thread. */
export async function writeRecallEntry(dir: string, threadId: string, entry: { hash: string; memory: string; createdAt: number }): Promise<{ entry: RecallEntry; path: string }> {
  const path = recallFilePath(dir, threadId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let source: string | null = null;
  try { source = await readFile(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const merged = appendEntry(parseRecallFile(source), entry);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(merged.file), { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return { entry: merged.entry, path };
}

/** Replaces the thread's cache with the skip marker (paused or deny-listed): `{"v":2,"skip":true}`, no hash, no prompt data. */
export async function writeSkipMarker(dir: string, threadId: string): Promise<{ path: string }> {
  const path = recallFilePath(dir, threadId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify({ v: 2, skip: true }), { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
  return { path };
}

/** Removes a thread's cache file; true when one existed. */
export async function deleteRecallFile(dir: string, threadId: string): Promise<boolean> {
  const path = recallFilePath(dir, threadId);
  try { await rm(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

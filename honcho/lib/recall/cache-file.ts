import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Recall cache file format shared with the harness hook (fixed; see common.md). */
export const RECALL_FILE_VERSION = 1;
export const RECALL_KEEP_ENTRIES = 5;
export const RECALL_TEXT_CHARS = 500;
export const THREAD_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface RecallEntry { counter: number; text: string; createdAt: number; memory: string }
export interface RecallFile { v: 1; entries: RecallEntry[] }

/** Trim, collapse whitespace, first 500 chars. The hook normalizes the same way. */
export function normalizePromptText(text: string): string {
  return text.trim().replace(/\s+/g, " ").slice(0, RECALL_TEXT_CHARS);
}

function isEntry(value: unknown): value is RecallEntry {
  const e = value as RecallEntry;
  return !!e && typeof e === "object" && Number.isSafeInteger(e.counter) && typeof e.text === "string"
    && Number.isFinite(e.createdAt) && typeof e.memory === "string";
}

export function parseRecallFile(source: string | null): RecallFile {
  if (!source) return { v: 1, entries: [] };
  try {
    const parsed = JSON.parse(source) as Partial<RecallFile>;
    if (parsed?.v !== RECALL_FILE_VERSION || !Array.isArray(parsed.entries)) return { v: 1, entries: [] };
    return { v: 1, entries: parsed.entries.filter(isEntry) };
  } catch { return { v: 1, entries: [] }; }
}

/** Pure merge: next counter, one entry per normalized text, newest 5 by counter. */
export function appendEntry(file: RecallFile, entry: { text: string; memory: string; createdAt: number }): { file: RecallFile; entry: RecallEntry } {
  const text = normalizePromptText(entry.text);
  const counter = file.entries.reduce((max, e) => Math.max(max, e.counter), 0) + 1;
  const next: RecallEntry = { counter, text, createdAt: entry.createdAt, memory: entry.memory };
  // A re-attempted dispatch of the same prompt replaces its older entry.
  const entries = [...file.entries.filter(e => e.text !== text), next]
    .sort((a, b) => a.counter - b.counter)
    .slice(-RECALL_KEEP_ENTRIES);
  return { file: { v: 1, entries }, entry: next };
}

export function recallFilePath(dir: string, threadId: string): string {
  if (!THREAD_ID_PATTERN.test(threadId)) throw new Error("Invalid thread id.");
  return join(dir, `${threadId}.json`);
}

/** Read-modify-write with an atomic rename. Callers serialize writes per thread. */
export async function writeRecallEntry(dir: string, threadId: string, entry: { text: string; memory: string; createdAt: number }): Promise<{ entry: RecallEntry; path: string }> {
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

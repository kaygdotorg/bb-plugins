// The narrow bb surface capture uses, plus capture-only collaborators (git
// facts from the thread's host, clock) that tests replace.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { posix } from "node:path";
import type { Deps, HarnessState, PrivacySettings } from "../contract.js";
import { HonchoError, type Conclusion, type ConclusionFilters, type HonchoClient, type Message, type Metadata } from "../honcho-client.js";

type Sdk = BbPluginApi["sdk"];
export type CaptureBb = {
  events: Pick<BbPluginApi["events"], "on">;
  storage: { kv: BbPluginApi["storage"]["kv"]; database?(): Database.Database };
  log: Pick<BbPluginApi["log"], "info" | "warn" | "error">;
  sdk: {
    threads: Pick<Sdk["threads"], "get" | "list"> & { events: Pick<Sdk["threads"]["events"], "list"> };
    environments: Pick<Sdk["environments"], "get">;
    projects: Pick<Sdk["projects"], "get">;
    files: Pick<Sdk["files"], "read">;
  };
};

// ---------- git facts from the thread's host ----------

export interface GitInfo { commonDir: string | null; remote: string | null }
export type GitInfoReader = (env: { hostId: string; path: string }) => Promise<GitInfo>;

/** A file bb says is not there (or is not a file). Any other read error (host offline,
 * timeout, permission) is not an answer: callers must not treat it as absent. */
export function isAbsentFile(error: unknown): boolean {
  const { code, status } = (error ?? {}) as { code?: unknown; status?: unknown };
  if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") return true;
  return status === 404 && (code === undefined || code === "not_found");
}

/** Reads .git through the thread's host with bb's file API, so no host worker
 * is needed. A worktree's .git file points at its gitdir, whose `commondir`
 * names the shared repo dir (what `git rev-parse --git-common-dir` prints).
 * Only "not found" counts as absent; other read errors reject, so a host that is
 * offline is never mistaken for "no repo, no remote". */
export function filesGitInfo(files: CaptureBb["sdk"]["files"]): GitInfoReader {
  const read = async (hostId: string, path: string): Promise<string | null> => {
    try {
      const file = await files.read({ hostId, path });
      return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    } catch (error) { if (isAbsentFile(error)) return null; throw error; }
  };
  return async ({ hostId, path }) => {
    let commonDir: string | null = null;
    // HEAD first: reading `.git` itself when it is a directory is an error, not "absent".
    if (await read(hostId, posix.join(path, ".git", "HEAD")) !== null) {
      commonDir = posix.join(path, ".git");
    } else {
      const dotGit = await read(hostId, posix.join(path, ".git"));
      const gitdir = dotGit?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (gitdir) {
        const dir = posix.resolve(path, gitdir);
        const common = (await read(hostId, posix.join(dir, "commondir")))?.trim();
        commonDir = common ? posix.resolve(dir, common) : posix.dirname(posix.dirname(dir));
      }
    }
    if (!commonDir) return { commonDir: null, remote: null };
    const config = await read(hostId, posix.join(commonDir, "config"));
    return { commonDir, remote: config ? remoteUrl(config) : null };
  };
}

/** origin's url from a git config, else the first remote's. */
export function remoteUrl(config: string): string | null {
  let section = "", first: string | null = null;
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(/^\s*\[\s*remote\s+"([^"]+)"\s*\]/);
    if (header) { section = header[1]; continue; }
    if (/^\s*\[/.test(line)) { section = ""; continue; }
    const url = section && line.match(/^\s*url\s*=\s*(.+?)\s*$/)?.[1];
    if (url) { if (section === "origin") return url; first ??= url; }
  }
  return first;
}

// ---------- honcho helpers ----------

const notFound = (error: unknown) => error instanceof HonchoError && error.status === 404;

/** Messages of a session by metadata; a missing session has none. */
export async function sessionMessages(client: HonchoClient, session: string, metadata: Metadata, max = 100_000): Promise<Message[]> {
  try { return await client.listAllMessages(session, metadata, max); }
  catch (error) { if (notFound(error)) return []; throw error; }
}

/** Tripwire probe: does a harness-named session hold any messages? */
export async function sessionHasMessages(client: HonchoClient, session: string): Promise<boolean> {
  try { return (await client.listMessages(session, {}, { page: 1, size: 1 })).items.length > 0; }
  catch (error) { if (notFound(error)) return false; throw error; }
}

/** Tripwire probe: when the newest message of a harness-named session was created (epoch ms),
 * or null when the session is missing or empty. Reads the newest message only. */
export async function sessionNewestMessageAt(client: HonchoClient, session: string): Promise<number | null> {
  try {
    const newest = (await client.listMessages(session, {}, { page: 1, size: 1, reverse: true })).items[0];
    return newest === undefined ? null : Date.parse(newest.created_at);
  } catch (error) { if (notFound(error)) return null; throw error; }
}

/** Tripwire probe: does a harness-named session hold a message created at or after `since` (epoch ms)? */
export async function sessionHasMessagesSince(client: HonchoClient, session: string, since: number): Promise<boolean> {
  const at = await sessionNewestMessageAt(client, session);
  return at !== null && at >= since;
}

export async function allConclusions(client: HonchoClient, filters: ConclusionFilters = {}, max = 100_000): Promise<Conclusion[]> {
  const out: Conclusion[] = [];
  for (let page = 1; out.length < max; page++) {
    const result = await client.listConclusions(filters, { page, size: 100 });
    out.push(...result.items);
    if (result.items.length < 100 || (result.total != null && out.length >= result.total)) break;
  }
  return out;
}

// ---------- deps capture takes on top of the shared ones ----------

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface CaptureSettings { captureRequiresSwitchover: boolean }

export interface CaptureDeps extends Deps {
  /** Privacy tab settings; default reads the Memory page's kv record (readPrivacy). */
  privacy?(): Promise<PrivacySettings> | PrivacySettings;
  /** Capture settings; captureRequiresSwitchover defaults to true. */
  settings?(): Promise<Partial<CaptureSettings>> | Partial<CaptureSettings>;
  /** Values from bb-secrets dotenv files, joined to the redaction deny set. */
  extraDeny?(): Promise<string[]> | string[];
  /** Conclusion ids saved from this thread without a session_id (honcho_conclude before its
   * session existed); the session cascade can't reach them, so purge deletes them by id. */
  unattachedConclusions?(threadId: string): string[];
  git?: GitInfoReader;
  /** The harness service's state for a machine: whether claude/codex are handed over there (bound late in server.ts). */
  harnessState?(machineId: string): Promise<HarnessState>;
  /** How long a machine's hand-over state is trusted; harness activity refreshes it sooner. Default 3 min. */
  handoverTtlMs?: number;
  clock?: Clock;
  random?: () => number;
  graceMs?: number;
  concurrency?: number;
  /** Upload lease owner id (default: random per service, i.e. per plugin generation). */
  leaseOwner?: string;
  leaseTtlMs?: number;
}

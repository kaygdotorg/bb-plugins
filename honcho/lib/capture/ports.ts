// The narrow bb surface capture uses, plus capture-only collaborators (git
// facts from the thread's host, clock) that tests replace.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type Database from "better-sqlite3";
import { posix } from "node:path";
import type { Deps, PrivacySettings } from "../contract.js";
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

/** Reads .git through the thread's host with bb's file API, so no host worker
 * is needed. A worktree's .git file points at its gitdir, whose `commondir`
 * names the shared repo dir (what `git rev-parse --git-common-dir` prints). */
export function filesGitInfo(files: CaptureBb["sdk"]["files"]): GitInfoReader {
  const read = async (hostId: string, path: string): Promise<string | null> => {
    try {
      const file = await files.read({ hostId, path });
      return file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content;
    } catch { return null; }
  };
  return async ({ hostId, path }) => {
    let commonDir: string | null = null;
    const dotGit = await read(hostId, posix.join(path, ".git"));
    const gitdir = dotGit?.match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (gitdir) {
      const dir = posix.resolve(path, gitdir);
      const common = (await read(hostId, posix.join(dir, "commondir")))?.trim();
      commonDir = common ? posix.resolve(dir, common) : posix.dirname(posix.dirname(dir));
    } else if (await read(hostId, posix.join(path, ".git", "HEAD")) !== null) {
      commonDir = posix.join(path, ".git");
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
  git?: GitInfoReader;
  clock?: Clock;
  random?: () => number;
  graceMs?: number;
  concurrency?: number;
  /** Upload lease owner id (default: random per service, i.e. per plugin generation). */
  leaseOwner?: string;
  leaseTtlMs?: number;
}

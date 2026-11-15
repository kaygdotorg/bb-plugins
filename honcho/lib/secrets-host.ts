// Host side of the bb-secrets redaction deny set. `bb secret request --write-env <path>`
// writes a dotenv file wherever the caller says (relative paths resolve from the thread's
// cwd), so there is no registry to read. The host scans the places agents write them:
// paths recorded by secret-request events (passed in by the server), thread storage, personal workspaces, ~/.bb/secrets, and BB_HONCHO_SECRET_PATHS
// (colon-separated files or directories). Values leave the host only over this one op.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { ExperimentalHostRpcContext } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { dotenvSecretValues } from "./redact.js";

export const MIN_SECRET_LENGTH = 8;
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES = 500;

export const secretsHostContract = {
  "secrets.read": {
    experimental_description: "Read the values of bb-secrets dotenv files on this host; unchanged when the fingerprint matches.",
    experimental_retryable: true,
    input: z.object({ fingerprint: z.string().max(100).optional(), paths: z.array(z.string().max(4096)).max(2000).optional() }).strict(),
    output: z.object({ fingerprint: z.string(), values: z.array(z.string()).nullable() }).strict(),
  },
};

const isDotenvName = (name: string) =>
  (/^\.env(\..+)?$/.test(name) || /\.env$/.test(name)) && !/\.(example|sample|template|dist)$/.test(name);

/** Directory patterns: `*` matches one path segment. */
async function expand(base: string, segments: string[]): Promise<string[]> {
  if (!segments.length) return [base];
  const [head, ...rest] = segments;
  if (head !== "*") return expand(join(base, head), rest);
  const names = await readdir(base).catch(() => [] as string[]);
  return (await Promise.all(names.map((n) => expand(join(base, n), rest)))).flat();
}

export interface SecretsScanOptions { home?: string; env?: NodeJS.ProcessEnv; /** Absolute dotenv paths from secret-request events. */ paths?: readonly string[] }

async function candidateFiles(options: SecretsScanOptions): Promise<string[]> {
  const home = options.home ?? homedir();
  const dirs = (await Promise.all([
    expand(home, [".bb", "secrets"]),
    expand(home, [".bb", "thread-storage", "*"]),
    expand(home, [".bb", "plugins", "*", "host-data", "workspaces", "*"]),
  ])).flat();
  const extra = (options.env ?? process.env).BB_HONCHO_SECRET_PATHS?.split(":").filter(Boolean) ?? [];
  extra.push(...(options.paths ?? []).filter((p) => isAbsolute(p)));
  const files: string[] = [];
  for (const target of [...dirs, ...extra]) {
    const info = await stat(target).catch(() => null);
    if (!info) continue;
    if (info.isFile()) { files.push(target); continue; }
    if (!info.isDirectory()) continue;
    for (const name of await readdir(target).catch(() => [] as string[])) if (isDotenvName(name)) files.push(join(target, name));
  }
  return [...new Set(files)].slice(0, MAX_FILES);
}

/** Stats first; reads values only when the (path, mtime, size) fingerprint changed. */
export async function scanSecrets(previous: string | undefined, options: SecretsScanOptions = {}): Promise<{ fingerprint: string; values: string[] | null }> {
  const entries: Array<{ path: string; size: number }> = [];
  const hash = createHash("sha256");
  for (const path of (await candidateFiles(options)).sort()) {
    const info = await stat(path).catch(() => null);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) continue;
    entries.push({ path, size: info.size });
    hash.update(`${path}\0${info.mtimeMs}\0${info.size}\n`);
  }
  const fingerprint = hash.digest("hex");
  if (fingerprint === previous) return { fingerprint, values: null };
  const values = new Set<string>();
  for (const { path } of entries) {
    const source = await readFile(path, "utf8").catch(() => "");
    for (const value of dotenvSecretValues(source)) if (value.length >= MIN_SECRET_LENGTH) values.add(value);
  }
  return { fingerprint, values: [...values] };
}

export function secretsHostHandlers(options: SecretsScanOptions = {}) {
  return {
    "secrets.read": (input: { fingerprint?: string; paths?: string[] }, _context?: ExperimentalHostRpcContext) => scanSecrets(input.fingerprint, { ...options, paths: input.paths }),
  };
}

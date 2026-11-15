import { execFileSync } from "node:child_process";
import { basename, dirname, resolve } from "node:path";

export const PROVIDER_PEERS = { "claude-code": "claude_code", codex: "codex", pi: "pi" } as const;
export function aiPeer(providerId: string): string {
  const peer = PROVIDER_PEERS[providerId as keyof typeof PROVIDER_PEERS] ?? providerId;
  if (!/^[a-zA-Z0-9_-]+$/.test(peer)) throw new Error("Invalid provider peer id.");
  return peer;
}
/** Same character-by-character normalization as claude-honcho 0.4.0. */
export function scopeSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (!slug) throw new Error("Scope name must not be empty.");
  return slug;
}
/** Exact repo-name derivation from claude-honcho src/git.ts. */
export function repoNameFromCommonDir(cwd: string, commonDir: string | null): string {
  if (!commonDir) return basename(resolve(cwd));
  const dir = resolve(cwd, commonDir);
  return basename(dir) === ".git" ? basename(dirname(dir)) : basename(dir).replace(/\.git$/, "");
}
export function getRepoName(cwd: string): string {
  let common: string | null = null;
  try { common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch { /* non-repo */ }
  return repoNameFromCommonDir(cwd, common);
}
export function sessionScope(input: { project: string; cwd?: string; commonDir?: string | null }): string {
  // The caller supplies the common dir from the thread's host, never the bb server's repo.
  return scopeSlug(input.cwd && input.commonDir ? repoNameFromCommonDir(input.cwd, input.commonDir) : input.project);
}
export interface SessionMetadataInput {
  provider: string; model?: string | null; host?: string | null;
  environment?: string | null; project?: string | null; parentThread?: string | null;
  origin?: string | null; sideChat?: boolean; automationId?: string | null;
}
export function sessionMetadata(input: SessionMetadataInput): Record<string, string | boolean> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

/** Observation belongs to the session relationship, never the global peer. */
export function sessionPeers(userPeer: string, providers: readonly string[]): Record<string, { observe_me: boolean; observe_others: boolean }> {
  const peers: Record<string, { observe_me: boolean; observe_others: boolean }> = {};
  for (const provider of providers) peers[aiPeer(provider)] = { observe_me: false, observe_others: false };
  if (peers[userPeer]) throw new Error("User and AI peer ids must differ.");
  peers[userPeer] = { observe_me: true, observe_others: false };
  return peers;
}

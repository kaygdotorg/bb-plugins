import { basename } from "node:path";

/** Verbatim from claude-honcho 0.4.0 src/config.ts `sanitizeForSessionName`. */
export function sanitizeForSessionName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}
/** claude-honcho `getSessionName(sessionId)`: the Claude Code session id, sanitized.
 * Its `CLAUDE_CODE_SESSION_ID` env fallback is deliberately not copied: this runs in
 * the bb server, whose environment says nothing about a historical thread. */
export function claudeSessionName(sessionId?: string): string | null {
  return sessionId ? sanitizeForSessionName(sessionId) : null;
}
/** Verbatim from codex-honcho `slug`. */
export function codexSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}
/** Codex `per-directory` session, and the repo part of every other strategy. */
export function codexPerDirectoryName(cwd: string): string {
  return codexSlug(basename(cwd));
}
/** Codex `chat-instance` session: `<repo>-<first 8 of the slugged chat id>`. */
export function codexChatInstanceName(cwd: string, chatId: string): string {
  return `${codexSlug(basename(cwd))}-${codexSlug(chatId).slice(0, 8)}`;
}
export const normalizeText = (text: string): string => text.replace(/\s+/g, " ").trim();

export const MATCH_WINDOW_MS = 120_000;
/** Text + timestamp index for the per-directory comparison. Holds hashes of nothing:
 * it is built in memory per run and dropped with it. */
export class TimeIndex {
  private readonly byText = new Map<string, number[]>();
  add(text: string, at: number): void {
    if (!Number.isFinite(at)) return;
    const key = normalizeText(text);
    const list = this.byText.get(key);
    if (list) list.push(at); else this.byText.set(key, [at]);
  }
  has(text: string, at: number, windowMs = MATCH_WINDOW_MS): boolean {
    return !!this.byText.get(normalizeText(text))?.some(t => Math.abs(t - at) <= windowMs);
  }
}

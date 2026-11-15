// bb-honcho hook body. Started only by bb-honcho-hook.sh when BB_HONCHO=1.
// Modes (argv[2], falling back to the event name on stdin):
//   prompt   Claude Code / Codex UserPromptSubmit: inject the per-turn recall
//            entry bb's host worker cached for this thread and prompt. The cache
//            (v2) holds a sha256 of the normalized dispatched text, never the text.
//   pretool  Claude Code PreToolUse on mcp__plugin_honcho_honcho__.*: deny.
// It must never fail a turn: every error path prints nothing and exits 0.
// Dependency-free on purpose: it runs from a copy in a bb-owned directory.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const START = Date.now();
const STALE_MS = 60_000;
const POLL_MS = 25;
const DEFAULT_BUDGET_MS = 400;
const MAX_BUDGET_MS = 5_000;
const MAX_STDIN = 4 * 1024 * 1024;
const HONCHO_MCP = /^mcp__plugin_honcho_honcho__/;
const DENY_MESSAGE = "honcho MCP is disabled inside bb, use honcho_chat / honcho_search instead";

const FILE_VERSION = 2;
const TEXT_CHARS = 500;

/** Same normalization and hash the recall cache writer uses (lib/recall/cache-file.ts). */
function normalize(text) {
  return String(text).trim().replace(/\s+/g, " ").slice(0, TEXT_CHARS);
}
function hash(normalized) {
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

// What bb adds around the dispatched text before the harness sees it (bb-app server/dist):
// the agent-to-agent envelope on the first text block (template agentThreadMessage),
const ENVELOPE = /^\[bb message from thread:[^;\]\s]+(?:;[^\]]*)?\]\s*/;
// plugin mention context appended after the input (resolvePluginMentionContextInputs),
const MENTION_CONTEXT = /(?:^|\n)Context for @[^\n]* \(resolved by plugin "[^"\n]+"\):\n/;
// and attachment markers, one per line (claude-code buildPromptText, codex toCodexUserInput).
const ATTACHMENT = /^\[Attached (?:image: \S+|(?:image|file)(?: "[^"\n]*")?(?: \([^()\n]*\))?\. It is on disk at .+ \u2014 use the Read tool to view it\.|file(?: "[^"\n]*")?: .+)\]$/;

/**
 * The normalized texts this prompt may have been dispatched as: the prompt
 * itself, then with each known wrapper stripped in turn (mention context
 * suffix, leading/trailing attachment lines, a leading envelope). Nothing else
 * is stripped, so an entry matches only when its text equals one of these.
 */
function candidates(prompt) {
  const out = new Set();
  let text = String(prompt).replace(/\r\n?/g, "\n");
  const add = () => { const n = normalize(text); if (n) out.add(n); };
  add();
  const context = MENTION_CONTEXT.exec(text);
  if (context) { text = text.slice(0, context.index); add(); }
  const lines = text.split("\n");
  const blank = (line) => !line.trim();
  const marker = (line) => ATTACHMENT.test(line.trim());
  let changed = false;
  while (lines.length && (blank(lines[lines.length - 1]) || marker(lines[lines.length - 1]))) { if (marker(lines.pop())) changed = true; }
  while (lines.length && (blank(lines[0]) || marker(lines[0]))) { if (marker(lines.shift())) changed = true; }
  if (changed) { text = lines.join("\n"); add(); }
  const envelope = ENVELOPE.exec(text);
  if (envelope) { text = text.slice(envelope[0].length); add(); }
  return [...out];
}

/**
 * The newest (by counter) fresh entry whose hash is one of the prompt's
 * candidates: { memory } to inject, { memory: "" } to stop waiting, or null
 * when nothing matches yet. Never an earlier, different prompt's result.
 */
function pickEntry(file, hashes, startedAt) {
  if (!file || typeof file !== "object" || file.v !== FILE_VERSION || !Array.isArray(file.entries)) return null;
  let best = null;
  for (const entry of file.entries) {
    if (!entry || typeof entry !== "object") continue;
    const { hash: entryHash, createdAt, memory, counter } = entry;
    if (typeof entryHash !== "string" || typeof memory !== "string" || typeof createdAt !== "number" || typeof counter !== "number") continue;
    if (createdAt < startedAt - STALE_MS) continue;
    if (!hashes.has(entryHash)) continue;
    if (!best || counter > best.counter || (counter === best.counter && createdAt > best.createdAt)) best = entry;
  }
  return best ? { memory: best.memory } : null;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    const chunks = [];
    let size = 0;
    process.stdin.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_STDIN) { process.stdin.destroy(); resolve(""); return; }
      chunks.push(chunk);
    });
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", () => resolve(""));
  });
}

function budgetMs() {
  const raw = Number.parseInt(process.env.BB_HONCHO_HOOK_BUDGET_MS ?? "", 10);
  if (!Number.isFinite(raw) || raw < 0) return DEFAULT_BUDGET_MS;
  return Math.min(raw, MAX_BUDGET_MS);
}

function readCache(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/** Resolves once the line is flushed, so process.exit cannot cut off async pipes (macOS). */
function emit(value) {
  return new Promise((resolve) => process.stdout.write(JSON.stringify(value) + "\n", () => resolve()));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function prompt(input) {
  const text = typeof input.prompt === "string" ? input.prompt : "";
  const dir = process.env.BB_HONCHO_RECALL_DIR;
  const thread = process.env.BB_THREAD_ID;
  if (!text.trim() || !dir || !thread || !/^[A-Za-z0-9_-]{1,128}$/.test(thread)) return;
  const path = join(dir, `${thread}.json`);
  const hashes = new Set(candidates(text).map(hash));
  if (!hashes.size) return;
  const deadline = START + budgetMs();
  for (;;) {
    const entry = pickEntry(readCache(path), hashes, START);
    // A matching entry is terminal: empty memory means "nothing for this prompt", stop at once.
    if (entry) {
      if (!entry.memory.trim()) return;
      const event = typeof input.hook_event_name === "string" && input.hook_event_name ? input.hook_event_name : "UserPromptSubmit";
      await emit({ hookSpecificOutput: { hookEventName: event, additionalContext: entry.memory } });
      return;
    }
    const left = deadline - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(POLL_MS, left));
  }
}

async function pretool(input) {
  if (typeof input.tool_name !== "string" || !HONCHO_MCP.test(input.tool_name)) return;
  await emit({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_MESSAGE },
  });
}

async function main() {
  if (process.env.BB_HONCHO !== "1") return;
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { return; }
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const mode = process.argv[2] || (input.hook_event_name === "PreToolUse" ? "pretool" : input.hook_event_name === "UserPromptSubmit" ? "prompt" : "");
  if (mode === "prompt") await prompt(input);
  else if (mode === "pretool") await pretool(input);
}

const quit = () => process.exit(0);
process.on("uncaughtException", quit);
process.on("unhandledRejection", quit);
process.stdout.on("error", quit);
main().then(quit, quit);

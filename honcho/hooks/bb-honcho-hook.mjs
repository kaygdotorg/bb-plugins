// bb-honcho hook body. Started only by bb-honcho-hook.sh when BB_HONCHO=1.
// Modes (argv[2], falling back to the event name on stdin):
//   prompt   Claude Code / Codex UserPromptSubmit: inject the per-turn recall
//            entry bb's host worker cached for this thread and prompt.
//   pretool  Claude Code PreToolUse on mcp__plugin_honcho_honcho__.*: deny.
// It must never fail a turn: every error path prints nothing and exits 0.
// Dependency-free on purpose: it runs from a copy in a bb-owned directory.
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

/** Same normalization the recall cache writer uses: trim, collapse whitespace, first 500 chars. */
function normalize(text) {
  return String(text).trim().replace(/\s+/g, " ").slice(0, 500);
}

/** Collapses whitespace in the whole prompt, so a cached prefix is still a substring. */
function normalizePrompt(text) {
  return String(text).trim().replace(/\s+/g, " ");
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

/** The newest usable entry for this prompt, or null. Never an earlier prompt's result. */
function pickEntry(file, prompt, startedAt) {
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.entries)) return null;
  const haystack = normalizePrompt(prompt);
  let best = null;
  for (const entry of file.entries) {
    if (!entry || typeof entry !== "object") continue;
    const { text, createdAt, memory, counter } = entry;
    if (typeof text !== "string" || typeof memory !== "string" || typeof createdAt !== "number") continue;
    const needle = normalize(text);
    if (!needle || !memory.trim()) continue;
    if (createdAt < startedAt - STALE_MS) continue;
    if (!haystack.includes(needle)) continue;
    const rank = [typeof counter === "number" ? counter : -Infinity, createdAt];
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && rank[1] > best.rank[1])) best = { entry, rank };
  }
  return best ? best.entry : null;
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
  const deadline = START + budgetMs();
  for (;;) {
    const entry = pickEntry(readCache(path), text, START);
    if (entry) {
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

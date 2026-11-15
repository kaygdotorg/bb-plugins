// Runs the real sh guard and node hook, from the bb-owned copy connect installs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { installHookFiles, layout, resolveHarnessPaths } from "../../lib/harness/ops";
import { normalizePromptText, promptHash } from "../../lib/recall/cache-file";

let root: string;
let hookSh: string;
let recallDir: string;
const THREAD = "thr_fake123";

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bb-honcho-hook-"));
  const paths = resolveHarnessPaths({ home: join(root, "home"), dataDir: join(root, "data"), env: {} });
  await installHookFiles(paths);
  hookSh = layout(paths).hookSh;
  recallDir = layout(paths).recallDir;
  mkdirSync(recallDir, { recursive: true });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const baseEnv = (extra: Record<string, string> = {}) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: join(root, "home"),
  BB_HONCHO: "1",
  BB_HONCHO_RECALL_DIR: recallDir,
  BB_THREAD_ID: THREAD,
  BB_HONCHO_HOOK_BUDGET_MS: "0",
  ...extra,
});

function run(mode: string, stdin: string, env: Record<string, string | undefined>) {
  const r = spawnSync("sh", [hookSh, mode], { input: stdin, env: env as NodeJS.ProcessEnv, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Entries are written as the recall writer does: the hash of the normalized dispatched text, never the text. */
type TestEntry = { counter: number; text: string; createdAt: number; memory: string };
function writeCache(thread: string, entries: TestEntry[]) {
  const v2 = entries.map(({ text, ...rest }) => ({ ...rest, hash: promptHash(normalizePromptText(text)) }));
  writeFileSync(join(recallDir, `${thread}.json`), JSON.stringify({ v: 2, entries: v2 }));
}
const injected = (stdout: string) => stdout ? JSON.parse(stdout).hookSpecificOutput.additionalContext : null;

const promptInput = (prompt: string) => JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s", prompt });

describe("gate", () => {
  it("exits 0 without starting node unless BB_HONCHO=1", () => {
    const bin = join(root, "fakebin");
    const marker = join(root, "node-started");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), `#!/bin/sh\ntouch '${marker}'\n`);
    chmodSync(join(bin, "node"), 0o755);
    for (const gate of [undefined, "0", "", "true"]) {
      const env: Record<string, string | undefined> = { ...baseEnv({ PATH: `${bin}:${process.env.PATH}` }) };
      if (gate === undefined) delete env.BB_HONCHO; else env.BB_HONCHO = gate;
      const r = run("prompt", "not even json", env);
      expect(r).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    expect(existsSync(marker)).toBe(false);
    run("prompt", "{}", baseEnv({ PATH: `${bin}:${process.env.PATH}` }));
    expect(existsSync(marker)).toBe(true);
  });
});

describe("prompt mode", () => {
  it("injects the matching entry as additionalContext", () => {
    writeCache(THREAD, [
      { counter: 1, text: "older   prompt", createdAt: Date.now(), memory: "older memory" },
      { counter: 2, text: "fix the   build", createdAt: Date.now(), memory: "kayg prefers small commits" },
    ]);
    const r = run("prompt", promptInput(" fix the\n build "), baseEnv());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "kayg prefers small commits" } });
  });

  it("never serves an earlier prompt whose text is only contained in this one", () => {
    writeCache(THREAD, [{ counter: 1, text: "ok", createdAt: Date.now(), memory: "memory for ok" }]);
    expect(run("prompt", promptInput("look at the failing build"), baseEnv()).stdout).toBe("");
    expect(run("prompt", promptInput("ok, now look at the failing build"), baseEnv()).stdout).toBe("");
    expect(run("prompt", promptInput("[bb envelope]\n ok"), baseEnv()).stdout).toBe("");
    expect(injected(run("prompt", promptInput("ok"), baseEnv()).stdout)).toBe("memory for ok");
  });

  it("strips only bb's own wrappers: agent envelope, attachment lines, plugin mention context", () => {
    writeCache(THREAD, [{ counter: 1, text: "deploy the api", createdAt: Date.now(), memory: "deploy memory" }]);
    const ok = (prompt: string) => expect(injected(run("prompt", promptInput(prompt), baseEnv()).stdout)).toBe("deploy memory");
    const miss = (prompt: string) => expect(run("prompt", promptInput(prompt), baseEnv()).stdout).toBe("");
    ok("[bb message from thread:thr_sender1]\n\ndeploy the api");
    ok("[bb message from thread:thr_sender1;reply=off]\n\ndeploy the api");
    ok("deploy the api\n[Attached image: https://example.test/a.png]");
    ok("deploy the api\n[Attached file \"notes.md\" (text/markdown, 12 bytes). It is on disk at /tmp/x/notes.md \u2014 use the Read tool to view it.]");
    ok("deploy the api\n[Attached file \"notes.md\": /tmp/x/notes.md]");
    ok("deploy the api\nContext for @Runbook (resolved by plugin \"docs\"):\n\nsteps one two three");
    ok("[bb message from thread:thr_s]\n\ndeploy the api\n[Attached image: https://example.test/a.png]\nContext for @Doc (resolved by plugin \"docs\"):\n\nbody");
    // Anything else around the text is a different prompt.
    miss("please deploy the api");
    miss("deploy the api now");
    miss("[bb automation due:auto_1]\ndeploy the api"); // the automation prefix is part of the dispatched text itself
    miss("deploy the api\n[Attached thing: x]");
    miss("note\n[bb message from thread:thr_s]\n\ndeploy the api");
  });

  it("grouped queued rows: matches the joined text bb dispatched, misses when per-row envelopes sit inside it", () => {
    // bb dispatches grouped rows as one input, the groups separated by a "\n\n" text block.
    writeCache(THREAD, [{ counter: 1, text: "first row\n\n\n\nsecond row", createdAt: Date.now(), memory: "grouped memory" }]);
    expect(injected(run("prompt", promptInput("first row\n\n\nsecond row"), baseEnv()).stdout)).toBe("grouped memory");
    expect(run("prompt", promptInput("first row"), baseEnv()).stdout).toBe("");
    expect(run("prompt", promptInput("second row"), baseEnv()).stdout).toBe("");
    // Agent-sent groups get an envelope per row; only a leading one is stripped, so this misses (conservative).
    const agent = "[bb message from thread:thr_s]\n\nfirst row\n\n\n[bb message from thread:thr_s]\n\nsecond row";
    expect(run("prompt", promptInput(agent), baseEnv()).stdout).toBe("");
  });

  it("an empty matching entry is terminal: nothing is injected and the hook reports it", () => {
    // An empty newer entry for the same prompt wins over an older one with memory.
    writeFileSync(join(recallDir, `${THREAD}.json`), JSON.stringify({ v: 2, entries: [
      { counter: 1, hash: promptHash("same prompt"), createdAt: Date.now(), memory: "older memory" },
      { counter: 3, hash: promptHash("same prompt"), createdAt: Date.now() - 1000, memory: "" },
    ] }));
    const r = run("prompt", promptInput("same prompt"), baseEnv({ BB_HONCHO_HOOK_BUDGET_MS: "5000", BB_HONCHO_HOOK_DEBUG: "1" }));
    expect([r.code, r.stdout, r.stderr.trim()]).toEqual([0, "", "bb-honcho-hook: terminal-empty-match"]);
  });

  it("the skip marker makes the hook exit with no output", () => {
    writeFileSync(join(recallDir, `${THREAD}.json`), JSON.stringify({ v: 2, skip: true }));
    const r = run("prompt", promptInput("anything"), baseEnv({ BB_HONCHO_HOOK_BUDGET_MS: "5000", BB_HONCHO_HOOK_DEBUG: "1" }));
    expect([r.code, r.stdout, r.stderr.trim()]).toEqual([0, "", "bb-honcho-hook: skip-marker"]);
  });

  it("reports hit and miss in debug mode", () => {
    writeCache(THREAD, [{ counter: 1, text: "dbg prompt", createdAt: Date.now(), memory: "m" }]);
    const env = baseEnv({ BB_HONCHO_HOOK_DEBUG: "1" });
    expect(run("prompt", promptInput("dbg prompt"), env).stderr.trim()).toBe("bb-honcho-hook: hit");
    expect(run("prompt", promptInput("other prompt"), env).stderr.trim()).toBe("bb-honcho-hook: miss");
  });

  it("ignores a v1 (plaintext) cache", () => {
    writeFileSync(join(recallDir, `${THREAD}.json`), JSON.stringify({ v: 1, entries: [{ counter: 1, text: "fix the build", createdAt: Date.now(), memory: "v1" }] }));
    expect(run("prompt", promptInput("fix the build"), baseEnv()).stdout).toBe("");
  });

  it("prefers the newest of several matching entries", () => {
    writeCache(THREAD, [
      { counter: 3, text: "same text", createdAt: Date.now(), memory: "first" },
      { counter: 4, text: "same text", createdAt: Date.now(), memory: "second" },
    ]);
    expect(injected(run("prompt", promptInput("same text"), baseEnv()).stdout)).toBe("second");
    // Counter ranks first, createdAt only breaks ties.
    writeFileSync(join(recallDir, `${THREAD}.json`), JSON.stringify({ v: 2, entries: [
      { counter: 9, hash: promptHash("same text"), createdAt: Date.now() - 5000, memory: "higher counter" },
      { counter: 8, hash: promptHash("same text"), createdAt: Date.now(), memory: "newer clock" },
    ] }));
    expect(injected(run("prompt", promptInput("same text"), baseEnv()).stdout)).toBe("higher counter");
  });

  it("outputs nothing on a miss", () => {
    writeCache(THREAD, [{ counter: 5, text: "something else", createdAt: Date.now(), memory: "m" }]);
    expect(run("prompt", promptInput("fix the build"), baseEnv())).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("ignores a stale entry", () => {
    writeCache(THREAD, [{ counter: 6, text: "fix the build", createdAt: Date.now() - 61_000, memory: "stale" }]);
    expect(run("prompt", promptInput("fix the build"), baseEnv()).stdout).toBe("");
  });

  it("ignores another thread's cache", () => {
    writeCache("thr_other", [{ counter: 7, text: "fix the build", createdAt: Date.now(), memory: "other thread" }]);
    rmSync(join(recallDir, `${THREAD}.json`), { force: true });
    expect(run("prompt", promptInput("fix the build"), baseEnv()).stdout).toBe("");
  });

  it("ignores entries without a valid hash, and unsafe thread ids", () => {
    writeFileSync(join(recallDir, `${THREAD}.json`), JSON.stringify({ v: 2, entries: [{ counter: 8, text: "anything", createdAt: Date.now(), memory: "no hash" }] }));
    expect(run("prompt", promptInput("anything"), baseEnv()).stdout).toBe("");
    expect(run("prompt", promptInput("anything"), baseEnv({ BB_THREAD_ID: "../escape" })).stdout).toBe("");
  });

  it("waits within its budget for the entry to arrive", async () => {
    rmSync(join(recallDir, `${THREAD}.json`), { force: true });
    const child = spawn("sh", [hookSh, "prompt"], { env: baseEnv({ BB_HONCHO_HOOK_BUDGET_MS: "5000" }) as NodeJS.ProcessEnv });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stdin.end(promptInput("late prompt"));
    await new Promise((r) => setTimeout(r, 150));
    writeCache(THREAD, [{ counter: 9, text: "late prompt", createdAt: Date.now(), memory: "arrived" }]);
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(JSON.parse(stdout).hookSpecificOutput.additionalContext).toBe("arrived");
  });

  it("exits 0 silently on malformed input or a corrupt cache", () => {
    for (const stdin of ["", "not json", "[]", "null", '{"prompt": 5}']) {
      expect(run("prompt", stdin, baseEnv())).toEqual({ code: 0, stdout: "", stderr: "" });
    }
    writeFileSync(join(recallDir, `${THREAD}.json`), "{ corrupt");
    expect(run("prompt", promptInput("fix the build"), baseEnv())).toEqual({ code: 0, stdout: "", stderr: "" });
    expect(run("prompt", promptInput("x"), baseEnv({ BB_HONCHO_RECALL_DIR: join(root, "missing") }))).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});

describe("pretool mode", () => {
  it("denies the old honcho MCP tools", () => {
    const r = run("pretool", JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "mcp__plugin_honcho_honcho__chat", tool_input: {} }), baseEnv());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "honcho MCP is disabled inside bb, use honcho_chat / honcho_search instead" },
    });
  });

  it("leaves other tools alone and exits 0 on malformed input", () => {
    expect(run("pretool", JSON.stringify({ tool_name: "Bash" }), baseEnv()).stdout).toBe("");
    expect(run("pretool", "{{{", baseEnv())).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("does nothing when the gate is off", () => {
    const env = baseEnv(); delete (env as Record<string, string | undefined>).BB_HONCHO;
    expect(run("pretool", JSON.stringify({ tool_name: "mcp__plugin_honcho_honcho__chat" }), env).stdout).toBe("");
  });
});

it("the hook body parses (node --check)", () => {
  const r = spawnSync(process.execPath, ["--check", fileURLToPath(new URL("../../hooks/bb-honcho-hook.mjs", import.meta.url))], { encoding: "utf8" });
  expect([r.status, r.stderr]).toEqual([0, ""]);
});

it("exits 0 when the node half is missing", () => {
  const lonely = join(root, "lonely", "bb-honcho-hook.sh");
  mkdirSync(dirname(lonely), { recursive: true });
  writeFileSync(lonely, "");
  spawnSync("cp", [hookSh, lonely]);
  const r = spawnSync("sh", [lonely, "prompt"], { input: promptInput("x"), env: baseEnv() as NodeJS.ProcessEnv, encoding: "utf8" });
  expect([r.status, r.stdout]).toEqual([0, ""]);
});

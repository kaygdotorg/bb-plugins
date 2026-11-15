// Runs the real sh guard and node hook, from the bb-owned copy connect installs.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installHookFiles, layout, resolveHarnessPaths } from "../../lib/harness/ops";

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

function writeCache(thread: string, entries: unknown[]) {
  writeFileSync(join(recallDir, `${thread}.json`), JSON.stringify({ v: 1, entries }));
}

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
    const r = run("prompt", promptInput("[bb envelope]\n fix the\n build please"), baseEnv());
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "kayg prefers small commits" } });
  });

  it("prefers the newest of several matching entries", () => {
    writeCache(THREAD, [
      { counter: 3, text: "same text", createdAt: Date.now(), memory: "first" },
      { counter: 4, text: "same text", createdAt: Date.now(), memory: "second" },
    ]);
    expect(JSON.parse(run("prompt", promptInput("same text"), baseEnv()).stdout).hookSpecificOutput.additionalContext).toBe("second");
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

  it("ignores entries with empty text, and unsafe thread ids", () => {
    writeCache(THREAD, [{ counter: 8, text: "   ", createdAt: Date.now(), memory: "matches everything" }]);
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

it("exits 0 when the node half is missing", () => {
  const lonely = join(root, "lonely", "bb-honcho-hook.sh");
  mkdirSync(dirname(lonely), { recursive: true });
  writeFileSync(lonely, "");
  spawnSync("cp", [hookSh, lonely]);
  const r = spawnSync("sh", [lonely, "prompt"], { input: promptInput("x"), env: baseEnv() as NodeJS.ProcessEnv, encoding: "utf8" });
  expect([r.status, r.stdout]).toEqual([0, ""]);
});

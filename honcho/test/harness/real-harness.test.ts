// Runs the real claude-honcho and codex-honcho config loaders against a fake
// HOME, when they are installed on this machine (read-only; skipped otherwise).
// Override the locations with BB_HONCHO_TEST_CLAUDE_HONCHO / BB_HONCHO_TEST_CODEX_HONCHO.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { prepareEnv, resolveHarnessPaths } from "../../lib/harness/ops";

function claudeStatusRunner(): string | null {
  if (process.env.BB_HONCHO_TEST_CLAUDE_HONCHO) return process.env.BB_HONCHO_TEST_CLAUDE_HONCHO;
  const cache = join(homedir(), ".claude", "plugins", "cache", "honcho", "honcho");
  try {
    for (const v of readdirSync(cache).sort().reverse()) {
      const runner = join(cache, v, "dist", "skills", "status-runner.js");
      if (existsSync(runner)) return runner;
    }
  } catch { /* not installed */ }
  return null;
}
const codexHoncho = process.env.BB_HONCHO_TEST_CODEX_HONCHO ?? join(homedir(), ".codex", "honcho", "codex-honcho.mjs");
const claudeRunner = claudeStatusRunner();

let root: string;
let home: string;
let env: { claudeConfigPath: string; codexConfigDir: string };
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "bb-honcho-real-"));
  home = join(root, "home");
  mkdirSync(join(home, ".honcho"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  // A credential claude-honcho and codex-honcho would find without bb's env. Fake, and
  // pointed at a closed local port so nothing leaves the machine.
  writeFileSync(join(home, ".honcho", "config.json"), JSON.stringify({
    apiKey: "hch-fake-top-level", baseUrl: "http://127.0.0.1:9",
    hosts: { claude_code: { apiKey: "hch-fake-claude", baseUrl: "http://127.0.0.1:9" }, codex: { apiKey: "hch-fake-codex", endpoint: "http://127.0.0.1:9" } },
  }));
  env = await prepareEnv(resolveHarnessPaths({ home, dataDir: join(root, "data"), env: {} }));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const isolated = (extra: Record<string, string>) => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, CODEX_HOME: join(home, ".codex"), NO_COLOR: "1", ...extra,
});
const runNode = (script: string, args: string[], extra: Record<string, string>, input = "") => {
  const r = spawnSync(process.execPath, [script, ...args], { env: isolated(extra), input, encoding: "utf8", timeout: 20_000 });
  return { code: r.status, out: (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, "") };
};

describe.skipIf(!claudeRunner)("claude-honcho (installed copy)", () => {
  it("finds no credential when HONCHO_CONFIG_PATH names a nonexistent file, despite ~/.honcho/config.json", () => {
    expect(existsSync(env.claudeConfigPath)).toBe(false);
    expect(runNode(claudeRunner!, [], { HONCHO_CONFIG_PATH: env.claudeConfigPath, HONCHO_API_KEY: "" }).out).toContain("Not configured");
  });

  it("does find the fake credential without bb's env (the control)", () => {
    expect(runNode(claudeRunner!, [], {}).out).not.toContain("Not configured");
  });

  it("would still take a shell-exported HONCHO_API_KEY, which is why bb clears it", () => {
    expect(runNode(claudeRunner!, [], { HONCHO_CONFIG_PATH: env.claudeConfigPath, HONCHO_API_KEY: "hch-fake-env" }).out).not.toContain("Not configured");
  });
});

describe.skipIf(!existsSync(codexHoncho))("codex-honcho (installed copy)", () => {
  it("reads bb's config dir instead of ~/.honcho and finds no key", () => {
    expect(runNode(codexHoncho, ["status"], { HONCHO_CONFIG_DIR: env.codexConfigDir }).out).toContain("honcho config: missing");
    expect(runNode(codexHoncho, ["status"], {}).out).toContain("honcho config: found");
  });

  it("stays silent on a prompt even with an env key, because enabled is false", () => {
    const r = runNode(codexHoncho, ["prompt"], { HONCHO_CONFIG_DIR: env.codexConfigDir, HONCHO_API_KEY: "hch-fake-env" },
      JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "hello", cwd: root, session_id: "s" }));
    expect(r).toEqual({ code: 0, out: "" });
  });
});

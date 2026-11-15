// Synthetic copies of the real harness file shapes. Every value is fake.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTrustHash, type DesiredHook } from "../../lib/harness/hooks-json";
import { resolveHarnessPaths, type HarnessPaths } from "../../lib/harness/ops";

export const FAKE_BEARER = "Bearer fake-token-not-real";

export interface FakeHome { root: string; home: string; dataDir: string; paths: HarnessPaths; read(rel: string): string | null; cleanup(): void }

const codexHonchoCmd = (codexDir: string, verb: string) => `node "${join(codexDir, "honcho", "codex-honcho.mjs")}" ${verb}`;

/** A user hook the handover must leave alone (and keep trusted). */
export const userPromptHook = (): DesiredHook => ({ event: "UserPromptSubmit", handler: { type: "command", command: "echo user-hook", timeout: 3 } });

export function codexHooksJson(codexDir: string): string {
  const file = {
    hooks: {
      SessionStart: [{ matcher: "startup|resume|clear|compact", hooks: [{ type: "command", command: codexHonchoCmd(codexDir, "recall"), timeout: 30, statusMessage: "honcho" }] }],
      UserPromptSubmit: [
        { hooks: [{ type: "command", command: codexHonchoCmd(codexDir, "prompt"), timeout: 20 }] },
        { hooks: [{ ...userPromptHook().handler }] },
      ],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: codexHonchoCmd(codexDir, "observe"), timeout: 10 }] }],
      Stop: [{ hooks: [{ type: "command", command: codexHonchoCmd(codexDir, "writeback"), timeout: 30 }] }],
      PreCompact: [{ matcher: "manual|auto", hooks: [{ type: "command", command: codexHonchoCmd(codexDir, "writeback"), timeout: 30 }] }],
    },
  };
  return JSON.stringify(file, null, 2) + "\n";
}

export function codexConfigToml(codexDir: string): string {
  const hooksPath = join(codexDir, "hooks.json");
  const trust = (event: string, g: number, hash: string) => `[hooks.state."${hooksPath}:${event}:${g}:0"]\ntrusted_hash = "${hash}"\n`;
  const userHash = codexTrustHash(userPromptHook());
  const honchoHash = codexTrustHash({ event: "UserPromptSubmit", handler: { type: "command", command: codexHonchoCmd(codexDir, "prompt"), timeout: 20 } });
  return [
    'model_provider = "pool"',
    "",
    "[model_providers.pool]",
    'name = "pool"',
    'base_url = "https://pool.example.invalid/v1"',
    `http_headers = { "Authorization" = "${FAKE_BEARER}" }`,
    "",
    "[features]",
    "hooks = true",
    "",
    "# >>> codex-honcho (honcho mcp) >>>",
    "[mcp_servers.honcho]",
    'url = "https://honcho.example.invalid/mcp"',
    `http_headers = { "Authorization" = "${FAKE_BEARER}", "X-Honcho-User-Name" = "fakeuser", "X-Honcho-Workspace-ID" = "fakews" }`,
    "",
    "[mcp_servers.honcho.tools]",
    "enabled = true",
    "",
    "[tui]",
    "screen_reader_detection_done = true",
    "",
    "[hooks.state]",
    "",
    trust("user_prompt_submit", 0, honchoHash),
    trust("user_prompt_submit", 1, userHash),
    `[projects."/tmp/fake-project"]`,
    'trust_level = "trusted"',
    "# <<< codex-honcho (honcho mcp) <<<",
    "",
  ].join("\n");
}

export function claudeSettingsJson(): string {
  return JSON.stringify({
    enabledPlugins: { "honcho@honcho": true, "other@market": true },
    env: { FAKE_FLAG: "1" },
    extraKnownMarketplaces: { honcho: { source: { source: "github", repo: "example/honcho" } } },
    hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user-stop" }] }] },
  }, null, 2) + "\n";
}

export function makeHome(opts: { claude?: boolean; codex?: boolean } = {}): FakeHome {
  const root = mkdtempSync(join(tmpdir(), "bb-honcho-harness-"));
  const home = join(root, "home");
  const dataDir = join(root, "data");
  const paths = resolveHarnessPaths({ home, dataDir, env: {} });
  if (opts.claude !== false) {
    mkdirSync(join(paths.claudeDir, "plugins", "cache", "honcho", "honcho", "0.4.0"), { recursive: true });
    writeFileSync(join(paths.claudeDir, "settings.json"), claudeSettingsJson());
    writeFileSync(join(paths.claudeDir, "plugins", "installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "honcho@honcho": [{ scope: "user", installPath: "/fake", version: "0.4.0" }] },
    }, null, 2));
  }
  if (opts.codex !== false) {
    mkdirSync(paths.codexDir, { recursive: true });
    writeFileSync(join(paths.codexDir, "hooks.json"), codexHooksJson(paths.codexDir));
    writeFileSync(join(paths.codexDir, "config.toml"), codexConfigToml(paths.codexDir), { mode: 0o600 });
  }
  return {
    root, home, dataDir, paths,
    read(rel) { try { return readFileSync(join(home, rel), "utf8"); } catch { return null; } },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

export const USER_FILES = [".claude/settings.json", ".codex/hooks.json", ".codex/config.toml"];
export const snapshot = (h: FakeHome) => Object.fromEntries(USER_FILES.map((f) => [f, h.read(f)]));

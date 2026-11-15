import { describe, expect, it } from "vitest";
import { codexEventLabel, codexHookKey, codexTrustHash } from "../../lib/harness/hooks-json";
import { hasHonchoMcp, readHookStates, rekeyHookStates, setHookTrust, stripBlock, stripHonchoMcp } from "../../lib/harness/toml";
import { render } from "./gen-assets.mjs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const FENCED = [
  'model = "x"',
  "",
  "# >>> codex-honcho (honcho mcp) >>>",
  "[mcp_servers.honcho]",
  'url = "https://honcho.example.invalid/mcp"',
  'http_headers = { "Authorization" = "Bearer fake" }',
  "",
  "[mcp_servers.honcho.env]",
  'A = "1"',
  "",
  "[tui]",
  "screen_reader_detection_done = true",
  "",
  "[hooks.state]",
  "",
  '[hooks.state."/h/hooks.json:stop:0:0"]',
  'trusted_hash = "sha256:aaa"',
  "",
  '[projects."/p"]',
  'trust_level = "trusted"',
  "# <<< codex-honcho (honcho mcp) <<<",
  "",
].join("\n");

describe("codex config.toml strip", () => {
  it("drops only the honcho MCP tables and keeps [tui], hooks.state and [projects…]", () => {
    const out = stripHonchoMcp(FENCED);
    expect(out).not.toContain("mcp_servers.honcho");
    expect(out).not.toContain("Bearer fake");
    expect(out).toContain('model = "x"');
    expect(out).toContain("[tui]\nscreen_reader_detection_done = true");
    expect(out).toContain('[hooks.state."/h/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:aaa"');
    expect(out).toContain('[projects."/p"]\ntrust_level = "trusted"');
    expect(readHookStates(out).states.get("/h/hooks.json:stop:0:0")?.trustedHash).toBe("sha256:aaa");
    expect(hasHonchoMcp(out)).toBe(false);
  });

  it("matches codex-honcho's stripBlock on content without the fence (unchanged)", () => {
    const plain = '[tui]\nx = 1\n';
    expect(stripBlock(plain)).toBe(plain);
    expect(stripHonchoMcp(plain)).toBe(plain);
  });

  it("drops an unfenced honcho MCP table and nothing after it", () => {
    const out = stripHonchoMcp('[mcp_servers.honcho]\nurl = "u"\n\n[mcp_servers.other]\nurl = "v"\n');
    expect(out).toBe('[mcp_servers.other]\nurl = "v"\n');
  });
});

describe("hooks.state edits", () => {
  it("renames and drops keys in one pass, so swaps never collide", () => {
    const toml = '[hooks.state."k:a:0:0"]\ntrusted_hash = "sha256:A"\n\n[hooks.state."k:a:1:0"]\ntrusted_hash = "sha256:B"\n\n[hooks.state."k:b:0:0"]\ntrusted_hash = "sha256:C"\n\n[tui]\nx = 1\n';
    const out = rekeyHookStates(toml, new Map([["k:a:0:0", "k:a:1:0"], ["k:a:1:0", "k:a:0:0"], ["k:b:0:0", null]]));
    const { states } = readHookStates(out);
    expect(states.get("k:a:1:0")?.trustedHash).toBe("sha256:A");
    expect(states.get("k:a:0:0")?.trustedHash).toBe("sha256:B");
    expect(states.has("k:b:0:0")).toBe(false);
    expect(out).toContain("[tui]\nx = 1");
  });

  it("handles the inline form inside [hooks.state]", () => {
    const toml = '[hooks.state]\n"k:a:1:0" = { trusted_hash = "sha256:A" }\n';
    const out = rekeyHookStates(toml, new Map([["k:a:1:0", "k:a:0:0"]]));
    expect(readHookStates(out).states.get("k:a:0:0")?.trustedHash).toBe("sha256:A");
    expect(readHookStates(setHookTrust(out, "k:a:0:0", "sha256:Z")).states.get("k:a:0:0")?.trustedHash).toBe("sha256:Z");
  });

  it("sets trust in place, inserts a missing line, or appends a table", () => {
    const existing = '[hooks.state."k"]\ntrusted_hash = "sha256:old"\n\n[tui]\n';
    expect(setHookTrust(existing, "k", "sha256:new")).toBe('[hooks.state."k"]\ntrusted_hash = "sha256:new"\n\n[tui]\n');
    expect(setHookTrust('[hooks.state."k"]\nenabled = true\n\n[tui]\n', "k", "sha256:n")).toBe('[hooks.state."k"]\nenabled = true\ntrusted_hash = "sha256:n"\n\n[tui]\n');
    expect(setHookTrust("[tui]\nx = 1\n", "/a b/hooks.json:stop:0:0", "sha256:n")).toBe('[tui]\nx = 1\n\n[hooks.state."/a b/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:n"\n');
    expect(setHookTrust("", "k", "sha256:n")).toBe('[hooks.state."k"]\ntrusted_hash = "sha256:n"\n');
  });

  it("refuses shapes it would corrupt, and reports them", () => {
    const inline = '[hooks]\nstate = { "k" = { trusted_hash = "x" } }\n';
    expect(() => setHookTrust(inline, "k", "sha256:n")).toThrow();
    expect(readHookStates(inline).unsupported).toBe(true);
  });
});

describe("codex hook trust hash", () => {
  // codex stores sha256 over the key-sorted compact JSON of the normalized hook
  // identity. The algorithm was checked once against a real codex 0.169
  // config.toml; the vectors here are synthetic, with the canonical JSON written
  // out by hand, so no digest of a real user's hook config lives in this repo.
  const sha = (canonical: string) => "sha256:" + createHash("sha256").update(canonical).digest("hex");

  it("hashes the key-sorted normalized identity, with async always false", () => {
    const command = 'node "/home/user/.codex/example/hook.mjs" prompt';
    expect(codexTrustHash({ event: "UserPromptSubmit", handler: { type: "command", command, timeout: 20 } }))
      .toBe(sha(`{"event_name":"user_prompt_submit","hooks":[{"async":false,"command":${JSON.stringify(command)},"timeout":20,"type":"command"}]}`));
    expect(codexTrustHash({ event: "Stop", handler: { type: "command", command: "true", timeout: 5 } }))
      .toBe(sha('{"event_name":"stop","hooks":[{"async":false,"command":"true","timeout":5,"type":"command"}]}'));
  });

  it("includes the matcher and statusMessage when set", () => {
    const command = 'node "/home/user/.codex/example/hook.mjs" recall';
    expect(codexTrustHash({ event: "SessionStart", matcher: "startup|resume", handler: { type: "command", command, timeout: 30, statusMessage: "example" } }))
      .toBe(sha(`{"event_name":"session_start","hooks":[{"async":false,"command":${JSON.stringify(command)},"statusMessage":"example","timeout":30,"type":"command"}],"matcher":"startup|resume"}`));
  });

  it("builds codex's state keys", () => {
    expect(codexEventLabel("PreCompact")).toBe("pre_compact");
    expect(codexHookKey("/h/hooks.json", { event: "UserPromptSubmit", group: 2, handler: 1 })).toBe("/h/hooks.json:user_prompt_submit:2:1");
  });
});

describe("embedded hook assets", () => {
  it("match hooks/ (regenerate with node test/harness/gen-assets.mjs)", () => {
    expect(readFileSync(new URL("../../lib/harness/hook-assets.ts", import.meta.url), "utf8")).toBe(render());
  });
});

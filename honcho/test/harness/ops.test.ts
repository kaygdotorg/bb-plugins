import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { codexHookKey, codexTrustHash } from "../../lib/harness/hooks-json";
import { connect, desiredHooks, handOver, harnessState, layout, prepareEnv, undo } from "../../lib/harness/ops";
import { readHookStates } from "../../lib/harness/toml";
import { FAKE_BEARER, makeHome, snapshot, userPromptHook, type FakeHome } from "./fixtures";

const homes: FakeHome[] = [];
afterEach(() => { for (const h of homes.splice(0)) h.cleanup(); });
const setup = (opts?: Parameters<typeof makeHome>[0]) => { const h = makeHome(opts); homes.push(h); return h; };
const json = (text: string | null) => JSON.parse(text ?? "null");

describe("connect", () => {
  it("installs the guard in both harnesses, keeps unrelated keys, and is idempotent", async () => {
    const h = setup();
    const original = json(h.read(".claude/settings.json"));
    const first = await connect(h.paths);
    expect(first.backup).not.toBeNull();
    const afterFirst = snapshot(h);

    const settings = json(afterFirst[".claude/settings.json"]!);
    expect(settings.env).toEqual(original.env);
    expect(settings.extraKnownMarketplaces).toEqual(original.extraKnownMarketplaces);
    expect(settings.enabledPlugins).toEqual(original.enabledPlugins);
    expect(settings.hooks.Stop).toEqual(original.hooks.Stop);
    expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
    expect(settings.hooks.PreToolUse).toEqual([{ matcher: "mcp__plugin_honcho_honcho__.*", hooks: [desiredHooks(h.paths).claude[1]!.handler] }]);
    const sh = layout(h.paths).hookSh;
    expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe(`sh '${sh}' prompt`);
    expect(statSync(sh).mode & 0o111).not.toBe(0);

    const codexHooks = json(afterFirst[".codex/hooks.json"]!);
    expect(codexHooks.hooks.UserPromptSubmit).toHaveLength(3);
    expect(codexHooks.hooks.SessionStart).toHaveLength(1);

    const second = await connect(h.paths);
    expect(second.backup).toBeNull();
    expect(snapshot(h)).toEqual(afterFirst);

    const state = await harnessState(h.paths);
    expect(state.claude).toEqual({ hookInstalled: true, handedOver: false, pluginVersion: "0.4.0" });
    expect(state.codex).toEqual({ hookInstalled: true, handedOver: false, trusted: true });
  });

  it("writes codex trust under the real key and hash, and keeps the toml's other content", async () => {
    const h = setup();
    const before = h.read(".codex/config.toml")!;
    await connect(h.paths);
    const after = h.read(".codex/config.toml")!;
    expect(after.startsWith(before.replace(/\n+$/, ""))).toBe(true);
    const key = codexHookKey(join(h.paths.codexDir, "hooks.json"), { event: "UserPromptSubmit", group: 2, handler: 0 });
    expect(readHookStates(after).states.get(key)?.trustedHash).toBe(codexTrustHash(desiredHooks(h.paths).codex[0]!));
  });

  it("replaces a stale copy of its own hook instead of adding a second one", async () => {
    const h = setup();
    await connect(h.paths);
    const path = join(h.home, ".claude/settings.json");
    const settings = json(readFileSync(path, "utf8"));
    settings.hooks.UserPromptSubmit[0].hooks[0].command = "sh '/old/place/bb-honcho-hook.sh' prompt";
    writeFileSync(path, JSON.stringify(settings, null, 2));
    await connect(h.paths);
    const fixed = json(readFileSync(path, "utf8"));
    expect(fixed.hooks.UserPromptSubmit).toHaveLength(1);
    expect(fixed.hooks.UserPromptSubmit[0].hooks[0].command).toContain(layout(h.paths).hookSh);
  });

  it("skips a harness whose config dir does not exist, and never creates it", async () => {
    const h = setup({ codex: false });
    await connect(h.paths);
    expect(existsSync(h.paths.codexDir)).toBe(false);
    expect((await harnessState(h.paths)).codex.hookInstalled).toBe(false);
  });

  it("refuses to overwrite a settings file it cannot parse", async () => {
    const h = setup();
    writeFileSync(join(h.home, ".claude/settings.json"), "{ not json");
    await expect(connect(h.paths)).rejects.toThrow("not valid JSON");
    expect(h.read(".claude/settings.json")).toBe("{ not json");
  });

  it("writes through a symlinked settings file", async () => {
    const h = setup();
    const real = join(h.root, "dotfiles-settings.json");
    renameSync(join(h.home, ".claude/settings.json"), real);
    symlinkSync(real, join(h.home, ".claude/settings.json"));
    await connect(h.paths);
    expect(json(readFileSync(real, "utf8")).hooks.PreToolUse).toHaveLength(1);
  });
});

describe("hand over", () => {
  it("disables claude-honcho and strips codex-honcho, keeping the rest", async () => {
    const h = setup();
    await handOver(h.paths);
    const settings = json(h.read(".claude/settings.json"));
    expect(settings.enabledPlugins).toEqual({ "honcho@honcho": false, "other@market": true });
    const hooks = json(h.read(".codex/hooks.json"));
    expect(hooks.hooks).toEqual({ UserPromptSubmit: [{ hooks: [userPromptHook().handler] }] });
    const toml = h.read(".codex/config.toml")!;
    expect(toml).not.toContain("mcp_servers.honcho");
    expect(toml).not.toContain("honcho.example.invalid");
    expect(toml).toContain(FAKE_BEARER); // the model provider header is not honcho's
    for (const kept of ["[tui]", "screen_reader_detection_done = true", '[projects."/tmp/fake-project"]', "[features]", "[model_providers.pool]"]) expect(toml).toContain(kept);
    const state = await harnessState(h.paths);
    expect(state.claude.handedOver).toBe(true);
    expect(state.codex.handedOver).toBe(true);
  });

  it("re-keys the surviving hooks' trust so they stay trusted", async () => {
    const h = setup();
    await handOver(h.paths);
    const { states } = readHookStates(h.read(".codex/config.toml")!);
    const hooksPath = join(h.paths.codexDir, "hooks.json");
    expect(states.get(codexHookKey(hooksPath, { event: "UserPromptSubmit", group: 0, handler: 0 }))?.trustedHash).toBe(codexTrustHash(userPromptHook()));
    expect(states.has(codexHookKey(hooksPath, { event: "UserPromptSubmit", group: 1, handler: 0 }))).toBe(false);
    expect(states.size).toBe(1);
  });

  it("keeps bb's own hook trusted when connect ran first", async () => {
    const h = setup();
    await connect(h.paths);
    await handOver(h.paths);
    const state = await harnessState(h.paths);
    expect(state.codex).toEqual({ hookInstalled: true, handedOver: true, trusted: true });
    expect(state.claude.hookInstalled).toBe(true);
  });

  it("is a no-op the second time", async () => {
    const h = setup();
    await handOver(h.paths);
    const once = snapshot(h);
    expect((await handOver(h.paths)).backup).toBeNull();
    expect(snapshot(h)).toEqual(once);
  });
});

describe("undo", () => {
  it("hand over then undo restores byte-identical files, and keeps the file mode", async () => {
    const h = setup();
    const original = snapshot(h);
    const mode = statSync(join(h.home, ".codex/config.toml")).mode;
    await handOver(h.paths);
    expect(snapshot(h)).not.toEqual(original);
    expect((await undo(h.paths)).restored).toHaveLength(1);
    expect(snapshot(h)).toEqual(original);
    expect(statSync(join(h.home, ".codex/config.toml")).mode).toBe(mode);
  });

  it("with no step undoes connect and hand over back to the original bytes", async () => {
    const h = setup();
    const original = snapshot(h);
    await connect(h.paths);
    await handOver(h.paths);
    expect((await undo(h.paths)).restored).toHaveLength(2);
    expect(snapshot(h)).toEqual(original);
    expect((await undo(h.paths)).restored).toEqual([]);
  });

  it("undoes only hand over, out of order, and keeps the hook connected and trusted", async () => {
    const h = setup();
    await handOver(h.paths);
    await connect(h.paths);
    await undo(h.paths, "handOver");
    const state = await harnessState(h.paths);
    expect(state.claude).toMatchObject({ hookInstalled: true, handedOver: false });
    expect(state.codex).toEqual({ hookInstalled: true, handedOver: false, trusted: true });
    expect(json(h.read(".codex/hooks.json")).hooks.SessionStart).toHaveLength(1);
  });

  it("undoes only connect, out of order, and keeps the hand over", async () => {
    const h = setup();
    const original = snapshot(h);
    await connect(h.paths);
    await handOver(h.paths);
    await undo(h.paths, "connect");
    const state = await harnessState(h.paths);
    expect(state.claude).toMatchObject({ hookInstalled: false, handedOver: true });
    expect(state.codex).toMatchObject({ hookInstalled: false, handedOver: true });
    expect(readHookStates(h.read(".codex/config.toml")!).states.size).toBe(1);
    // and undoing the hand over afterwards lands on the original bytes
    await undo(h.paths, "handOver");
    expect(snapshot(h)).toEqual(original);
  });

  it("undoing connect when it is the newest step restores its bytes", async () => {
    const h = setup();
    const original = snapshot(h);
    await connect(h.paths);
    await undo(h.paths, "connect");
    expect(snapshot(h)).toEqual(original);
    expect((await undo(h.paths, "connect")).restored).toEqual([]);
  });

  it("removes files a step created", async () => {
    const h = setup();
    writeFileSync(join(h.home, ".codex/hooks.json"), "");
    const toml = join(h.home, ".codex/config.toml");
    renameSync(toml, join(h.root, "moved.toml"));
    await connect(h.paths);
    expect(existsSync(toml)).toBe(true);
    await undo(h.paths);
    expect(existsSync(toml)).toBe(false);
    expect(h.read(".codex/hooks.json")).toBe("");
  });
});

describe("env paths", () => {
  it("creates the codex-honcho config with enabled:false and no key, and keeps the claude path nonexistent", async () => {
    const h = setup();
    const p = await prepareEnv(h.paths);
    expect(json(readFileSync(join(p.codexConfigDir, "config.json"), "utf8"))).toEqual({ enabled: false });
    writeFileSync(p.claudeConfigPath, "{}");
    await prepareEnv(h.paths);
    expect(existsSync(p.claudeConfigPath)).toBe(false);
    expect(p.recallDir).toBe(join(h.dataDir, "recall"));
  });
});

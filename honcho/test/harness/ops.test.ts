import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { listBackups, testHooks } from "../../lib/harness/files";
import { codexHookKey, codexTrustHash } from "../../lib/harness/hooks-json";
import { connect, desiredHooks, handOver, harnessState, layout, prepareEnv, undo } from "../../lib/harness/ops";
import { readHookStates } from "../../lib/harness/toml";
import { claudeSettingsJson, codexConfigToml, codexHooksJson, FAKE_BEARER, makeHome, snapshot, userPromptHook, type FakeHome } from "./fixtures";

const homes: FakeHome[] = [];
afterEach(() => { delete testHooks.beforeSwap; for (const h of homes.splice(0)) h.cleanup(); });
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

describe("undo keeps edits made after the step", () => {
  const edit = (h: FakeHome, rel: string, change: (value: any) => void) => {
    const path = join(h.home, rel);
    const value = json(readFileSync(path, "utf8"));
    change(value);
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
  };
  const userStop = { hooks: [{ type: "command", command: "echo later" }] };

  it("undo connect keeps a settings.json connect created once the user edited it", async () => {
    const h = setup();
    rmSync(join(h.home, ".claude/settings.json"));
    await connect(h.paths);
    edit(h, ".claude/settings.json", (s) => { s.model = "opus"; s.hooks.Stop = [userStop]; });
    await undo(h.paths, "connect");
    expect(json(h.read(".claude/settings.json"))).toEqual({ hooks: { Stop: [userStop] }, model: "opus" });
    expect((await harnessState(h.paths)).claude.hookInstalled).toBe(false);
  });

  it("undo connect keeps a codex hooks.json connect created once the user edited it", async () => {
    const h = setup();
    rmSync(join(h.home, ".codex/hooks.json"));
    await connect(h.paths);
    edit(h, ".codex/hooks.json", (s) => { s.hooks.Stop = [userStop]; });
    await undo(h.paths);
    expect(json(h.read(".codex/hooks.json"))).toEqual({ hooks: { Stop: [userStop] } });
    // the trust connect granted is gone again, the rest of the toml is as it was
    expect(h.read(".codex/config.toml")).toBe(codexConfigToml(h.paths.codexDir));
  });

  it("undo connect still removes a file connect created when nobody touched it", async () => {
    const h = setup();
    rmSync(join(h.home, ".claude/settings.json"));
    await connect(h.paths);
    await undo(h.paths, "connect");
    expect(existsSync(join(h.home, ".claude/settings.json"))).toBe(false);
  });

  it("undo hand over keeps later harness writes and puts back only what hand over removed", async () => {
    const h = setup();
    await handOver(h.paths);
    edit(h, ".claude/settings.json", (s) => { s.permissions = { allow: ["Bash(ls)"] }; });
    const tomlPath = join(h.home, ".codex/config.toml");
    writeFileSync(tomlPath, readFileSync(tomlPath, "utf8") + '\n[projects."/tmp/later"]\ntrust_level = "trusted"\n');
    expect((await undo(h.paths, "handOver")).restored).toHaveLength(1);

    const settings = json(h.read(".claude/settings.json"));
    expect(settings).toEqual({ ...json(claudeSettingsJson()), permissions: { allow: ["Bash(ls)"] } });
    expect(json(h.read(".codex/hooks.json"))).toEqual(json(codexHooksJson(h.paths.codexDir)));
    const toml = h.read(".codex/config.toml")!;
    expect(toml).toContain('[projects."/tmp/later"]');
    expect(toml).toContain("[mcp_servers.honcho]");
    expect(toml).toContain("[mcp_servers.honcho.tools]");
    expect(toml).toContain("honcho.example.invalid");
    const { states } = readHookStates(toml);
    expect(states).toEqual(readHookStates(codexConfigToml(h.paths.codexDir)).states);
    const state = await harnessState(h.paths);
    expect(state.claude.handedOver).toBe(false);
    expect(state.codex.handedOver).toBe(false);
    // codex-honcho's own strip still finds what was put back
    await handOver(h.paths);
    expect(h.read(".codex/config.toml")).not.toContain("mcp_servers.honcho");
  });

  it("undo hand over removes the enabledPlugins entry it added", async () => {
    const h = setup();
    writeFileSync(join(h.home, ".claude/settings.json"), JSON.stringify({ env: { A: "1" } }, null, 2) + "\n");
    await handOver(h.paths);
    edit(h, ".claude/settings.json", (s) => { s.model = "opus"; });
    await undo(h.paths, "handOver");
    expect(json(h.read(".claude/settings.json"))).toEqual({ env: { A: "1" }, model: "opus" });
  });

  it("out-of-order undos with later edits keep the edits and end with both steps undone", async () => {
    const h = setup();
    await connect(h.paths);
    await handOver(h.paths);
    edit(h, ".claude/settings.json", (s) => { s.model = "opus"; });
    await undo(h.paths, "connect");
    await undo(h.paths, "handOver");
    expect(json(h.read(".claude/settings.json"))).toEqual({ ...json(claudeSettingsJson()), model: "opus" });
    expect(snapshot(h)[".codex/hooks.json"]).toBe(codexHooksJson(h.paths.codexDir));
    expect(h.read(".codex/config.toml")).toBe(codexConfigToml(h.paths.codexDir));
    const state = await harnessState(h.paths);
    expect(state.claude).toMatchObject({ hookInstalled: false, handedOver: false });
    expect(state.codex).toMatchObject({ hookInstalled: false, handedOver: false });
  });

  it("out-of-order hand over undo after connect re-keys bb's hook so it stays trusted", async () => {
    const h = setup();
    const original = snapshot(h);
    await handOver(h.paths);
    await connect(h.paths);
    edit(h, ".claude/settings.json", (s) => { s.model = "opus"; });
    await undo(h.paths, "handOver");
    expect((await harnessState(h.paths)).codex).toEqual({ hookInstalled: true, handedOver: false, trusted: true });
    await undo(h.paths, "connect");
    const now = snapshot(h);
    expect(now[".codex/hooks.json"]).toBe(original[".codex/hooks.json"]);
    expect(now[".codex/config.toml"]).toBe(original[".codex/config.toml"]);
    expect(json(now[".claude/settings.json"]!)).toEqual({ ...json(original[".claude/settings.json"]!), model: "opus" });
  });
});

describe("concurrent writers", () => {
  it("re-reads and retries when a file changes between the read and the write", async () => {
    const h = setup();
    const settings = join(h.home, ".claude/settings.json");
    let fired = false;
    testHooks.beforeSwap = (path) => {
      if (fired || path !== settings) return;
      fired = true;
      writeFileSync(settings, JSON.stringify({ ...json(readFileSync(settings, "utf8")), model: "opus" }, null, 2) + "\n");
    };
    await connect(h.paths);
    expect(fired).toBe(true);
    const after = json(h.read(".claude/settings.json"));
    expect(after.model).toBe("opus");
    expect(after.hooks.PreToolUse).toHaveLength(1);
    expect((await listBackups(layout(h.paths).backupsDir)).map((b) => b.manifest.op)).toEqual(["connect"]);
    // the backup holds the bytes the edit was made from, so undo keeps the concurrent edit
    await undo(h.paths);
    expect(json(h.read(".claude/settings.json"))).toEqual({ ...json(claudeSettingsJson()), model: "opus" });
  });

  it("gives up after its retries, rolling back the files it had already written", async () => {
    const h = setup();
    const original = snapshot(h);
    const hooks = join(h.home, ".codex/hooks.json");
    let n = 0;
    testHooks.beforeSwap = (path) => {
      if (path !== hooks) return;
      n += 1;
      writeFileSync(hooks, codexHooksJson(h.paths.codexDir).replace("echo user-hook", `echo user-hook-${n}`));
    };
    await expect(connect(h.paths)).rejects.toThrow(/kept changing.*no file was changed/);
    expect(n).toBe(4);
    const now = snapshot(h);
    expect(now[".claude/settings.json"]).toBe(original[".claude/settings.json"]);
    expect(now[".codex/config.toml"]).toBe(original[".codex/config.toml"]);
    expect(now[".codex/hooks.json"]).toContain("echo user-hook-4");
    expect(await listBackups(layout(h.paths).backupsDir)).toEqual([]);
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

describe("codex-honcho skill", () => {
  const SKILL_FILES: Record<string, Buffer> = {
    "SKILL.md": Buffer.from("# fake skill\nhooks inject context\n"),
    "refs/notes.bin": Buffer.from([0, 255, 1, 254, 10, 13]),
  };
  const addSkill = (h: FakeHome) => {
    const dir = layout(h.paths).codexHonchoSkill;
    for (const [rel, bytes] of Object.entries(SKILL_FILES)) {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), bytes);
    }
    return dir;
  };
  const skillBytes = (dir: string) => Object.fromEntries(Object.keys(SKILL_FILES).map((r) => [r, readFileSync(join(dir, r)).toString("hex")]));

  it("hand over moves it into the backup set and undo puts it back byte for byte", async () => {
    const h = setup();
    const dir = addSkill(h);
    const before = skillBytes(dir);
    const original = snapshot(h);
    expect(h.paths.codexDir).toBe(join(h.home, ".codex"));
    expect(dir).toBe(join(h.home, ".codex", "skills", "honcho-memory"));
    await handOver(h.paths);
    expect(existsSync(dir)).toBe(false);
    expect((await harnessState(h.paths)).codex.handedOver).toBe(true);
    expect((await undo(h.paths, "handOver")).restored).toHaveLength(1);
    expect(skillBytes(dir)).toEqual(before);
    expect(snapshot(h)).toEqual(original);
  });

  it("is not handed over while the skill is in place", async () => {
    const h = setup();
    addSkill(h);
    await handOver(h.paths);
    mkdirSync(layout(h.paths).codexHonchoSkill, { recursive: true });
    expect((await harnessState(h.paths)).codex.handedOver).toBe(false);
  });

  it("a second hand over on a machine handed over before only moves the skill, and undo goes step by step", async () => {
    const h = setup();
    const original = snapshot(h);
    const first = (await handOver(h.paths)).backup;
    const handedOver = snapshot(h);
    const dir = addSkill(h);
    const before = skillBytes(dir);
    const second = (await handOver(h.paths)).backup;
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(snapshot(h)).toEqual(handedOver);
    expect(existsSync(dir)).toBe(false);
    expect((await handOver(h.paths)).backup).toBeNull();

    await undo(h.paths, "handOver");
    expect(skillBytes(dir)).toEqual(before);
    expect(snapshot(h)).toEqual(handedOver);
    await undo(h.paths, "handOver");
    expect(snapshot(h)).toEqual(original);
  });

  it("undo with no step restores files and skill", async () => {
    const h = setup();
    const dir = addSkill(h);
    const before = skillBytes(dir);
    const original = snapshot(h);
    await connect(h.paths);
    await handOver(h.paths);
    await undo(h.paths);
    expect(snapshot(h)).toEqual(original);
    expect(skillBytes(dir)).toEqual(before);
  });

  it("does not clobber a skill dir that exists again at undo time", async () => {
    const h = setup();
    const dir = addSkill(h);
    await handOver(h.paths);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "user's own");
    const result = await undo(h.paths, "handOver");
    expect(result.kept).toEqual([dir]);
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toBe("user's own");
  });

  it("leaves a machine without the skill alone", async () => {
    const h = setup();
    await handOver(h.paths);
    expect(existsSync(layout(h.paths).codexHonchoSkill)).toBe(false);
    expect(existsSync(join(h.home, ".codex", "skills"))).toBe(false);
  });
});

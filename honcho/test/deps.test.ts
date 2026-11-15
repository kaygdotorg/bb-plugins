import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { CLOUD_URL, CONFIG_CACHE_MS, createDeps, defineSettings } from "../lib/deps";
import { HonchoClient, HonchoError } from "../lib/honcho-client";
import { Outbox } from "../lib/outbox";
import { RingActivityLog } from "../lib/activity";

const dirs: string[] = [];
const disposers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const d of disposers.splice(0)) await d();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(file: unknown, settings: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "honcho-deps-")); dirs.push(dir);
  const configPath = join(dir, "config.json"); await writeFile(configPath, JSON.stringify(file));
  const { bb, harness } = createFakePluginHost({ pluginId: "honcho", settings });
  disposers.push(() => harness.lifecycle.dispose());
  const handle = defineSettings(bb);
  return { bb, harness, configPath, handle, deps: createDeps(bb, { settings: handle, configPath }) };
}
const rejectsWith = async (promise: Promise<unknown>, kind: string) => { await expect(promise).rejects.toBeInstanceOf(HonchoError); await expect(promise).rejects.toMatchObject({ kind }); };

describe("createDeps", () => {
  it("defines every plugin setting in one place, with the key as a secret", async () => {
    const { harness } = await setup({});
    expect(Object.keys(harness.registrations.settingsDescriptors).sort()).toEqual([
      "apiKey", "backfillMessagesPerMinute", "baseUrl", "captureRequiresSwitchover", "codexUseBbTools", "hookBudgetMs", "peerName", "preset", "workspace",
    ]);
    expect(harness.registrations.settingsDescriptors.apiKey).toMatchObject({ type: "string", secret: true });
    expect(harness.registrations.settingsDescriptors.preset).toMatchObject({ type: "select", options: ["cloud", "self-hosted"] });
  });
  it("reads the config file live and picks up an edit without a reload", async () => {
    const { deps, configPath } = await setup({ baseUrl: "http://one.test", apiKey: "synthetic-one", workspace: "w1" });
    expect((await deps.config()).config).toMatchObject({ baseUrl: "http://one.test", apiKey: "synthetic-one", workspace: "w1" });
    await writeFile(configPath, JSON.stringify({ baseUrl: "http://two.test/v3", apiKey: "synthetic-rotated", workspace: "w2" }));
    expect((await deps.config()).config).toMatchObject({ baseUrl: "http://two.test", apiKey: "synthetic-rotated", workspace: "w2" });
  });
  it("caches the config for 5 seconds unless the file or a setting changed", async () => {
    let now = 1_000_000;
    const dir = await mkdtemp(join(tmpdir(), "honcho-deps-")); dirs.push(dir);
    const configPath = join(dir, "config.json"); await writeFile(configPath, JSON.stringify({ baseUrl: "http://a.test" }));
    const { bb, harness } = createFakePluginHost({ pluginId: "honcho" }); disposers.push(() => harness.lifecycle.dispose());
    const deps = createDeps(bb, { configPath, now: () => now });
    expect((await deps.config()).config.baseUrl).toBe("http://a.test");
    // Same size and mtime: only the TTL can make this edit visible.
    const before = await stat(configPath);
    await writeFile(configPath, JSON.stringify({ baseUrl: "http://b.test" })); await utimes(configPath, before.atimeMs / 1000, before.mtimeMs / 1000);
    now += CONFIG_CACHE_MS - 1; expect((await deps.config()).config.baseUrl).toBe("http://a.test");
    // A bb setting change invalidates immediately.
    await harness.setSettings({ workspace: "changed" }); expect((await deps.config()).config).toMatchObject({ baseUrl: "http://b.test", workspace: "changed" });
    await writeFile(configPath, JSON.stringify({ baseUrl: "http://c.test" })); await utimes(configPath, before.atimeMs / 1000, before.mtimeMs / 1000);
    expect((await deps.config()).config.baseUrl).toBe("http://b.test");
    now += CONFIG_CACHE_MS; expect((await deps.config()).config.baseUrl).toBe("http://c.test");
  });
  it("lets bb settings override the file, and treats empty values as inherit", async () => {
    const { deps, harness } = await setup({ baseUrl: "http://file.test", apiKey: "synthetic-file", workspace: "file", peerName: "file-peer" }, { workspace: "bb-ws", peerName: "" });
    expect((await deps.config()).config).toEqual({ baseUrl: "http://file.test", apiKey: "synthetic-file", workspace: "bb-ws", peerName: "file-peer" });
    await harness.setSettings({ apiKey: "synthetic-secret-override", baseUrl: "http://bb.test" });
    const result = await deps.config();
    expect(result.config).toMatchObject({ baseUrl: "http://bb.test", apiKey: "synthetic-secret-override" });
    expect(result.warnings.join()).not.toContain("synthetic");
    expect(result.keys).toContain("synthetic-secret-override");
    await harness.setSettings({ apiKey: null, baseUrl: null });
    expect((await deps.config()).config).toMatchObject({ baseUrl: "http://file.test", apiKey: "synthetic-file" });
  });
  it("builds the client from the current config and rebuilds it when the key rotates", async () => {
    const { deps, configPath } = await setup({ baseUrl: "http://one.test", apiKey: "synthetic-one" });
    const first = await deps.client();
    expect(first).toBeInstanceOf(HonchoClient); expect(await deps.client()).toBe(first);
    await writeFile(configPath, JSON.stringify({ baseUrl: "http://one.test", apiKey: "synthetic-rotated-key" }));
    expect(await deps.client()).not.toBe(first);
  });
  it("sends the configured key and workspace through the client", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const dir = await mkdtemp(join(tmpdir(), "honcho-deps-")); dirs.push(dir);
    const configPath = join(dir, "config.json"); await writeFile(configPath, JSON.stringify({ baseUrl: "http://self.test/v3", apiKey: "synthetic-key", workspace: "ws" }));
    const { bb, harness } = createFakePluginHost({ pluginId: "honcho" }); disposers.push(() => harness.lifecycle.dispose());
    await (await createDeps(bb, { configPath, fetch: fetchMock }).client()).getOrCreateWorkspace();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://self.test/v3/workspaces");
    expect((init?.headers as Record<string, string>).authorization).toBe("Bearer synthetic-key");
    expect(JSON.parse(init?.body as string)).toMatchObject({ id: "ws" });
  });
  it("throws HonchoError(auth) for the cloud without a key, but allows a self-hosted server without one", async () => {
    const cloud = await setup({}); // default url is the cloud
    expect(await cloud.deps.isCloud()).toBe(true); await rejectsWith(cloud.deps.client(), "auth");
    const hosted = await setup({ baseUrl: "http://self.test" });
    expect(await hosted.deps.isCloud()).toBe(false); expect(await hosted.deps.client()).toBeInstanceOf(HonchoClient);
    await hosted.harness.setSettings({ preset: "cloud" });
    await rejectsWith(hosted.deps.client(), "auth");
  });
  it("never sends a self-hosted key to the cloud preset", async () => {
    const { deps } = await setup({ baseUrl: "http://self.test", apiKey: "synthetic-self-hosted" }, { preset: "cloud" });
    const { config } = await deps.config();
    expect(config).toMatchObject({ baseUrl: CLOUD_URL, apiKey: "" });
    await rejectsWith(deps.client(), "auth");
  });
  it("throws a HonchoError for an unusable config instead of leaking the parse error", async () => {
    const { deps, configPath } = await setup({});
    await writeFile(configPath, '{"apiKey":"synthetic-private" broken');
    await rejectsWith(deps.config(), "validation"); await rejectsWith(deps.client(), "validation");
  });
  it("opens the outbox lazily, once, through bb.storage.database", async () => {
    const { bb, configPath, handle } = await setup({});
    const database = vi.fn(() => bb.storage.database());
    const deps = createDeps({ settings: bb.settings, storage: { ...bb.storage, database } }, { configPath, settings: handle });
    expect(database).not.toHaveBeenCalled();
    const outbox = deps.outbox; expect(outbox).toBeInstanceOf(Outbox); expect(deps.outbox).toBe(outbox); expect(database).toHaveBeenCalledTimes(1);
    outbox.advance("thread", 3); expect(deps.outbox.cursor("thread")).toBe(3);
  });
  it("provides an activity log", async () => {
    const { deps } = await setup({}); expect(deps.activity).toBeInstanceOf(RingActivityLog);
    deps.activity.record({ kind: "harness", summary: "x" }); expect(deps.activity.list()).toHaveLength(1);
  });

  it("never sends the file key to a different bb base URL unless the bb key is set", async () => {
    const { deps, harness } = await setup({ baseUrl: "http://file.test", apiKey: "synthetic-file-key" });
    await harness.setSettings({ baseUrl: "http://other.test" });
    expect((await deps.config()).config).toMatchObject({ baseUrl: "http://other.test", apiKey: "" });
    await harness.setSettings({ apiKey: "synthetic-bb-key" });
    expect((await deps.config()).config.apiKey).toBe("synthetic-bb-key");
  });
  it("does not cache a load that was in flight during a settings change", async () => {
    const { deps, harness } = await setup({ baseUrl: "http://file.test", workspace: "old" });
    const inFlight = deps.config();
    await harness.setSettings({ workspace: "new" });
    await inFlight;
    expect((await deps.config()).config.workspace).toBe("new");
    expect((await deps.config()).config.workspace).toBe("new");
  });
});

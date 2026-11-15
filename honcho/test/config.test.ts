import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redact } from "../lib/redact";
import { configKeys, listConfigKeys, readConfig } from "../lib/config";
const directories: string[] = [];
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function file(value: unknown) {
  const dir = await mkdtemp(join(tmpdir(), "honcho-test-")); directories.push(dir);
  const path = join(dir, "config.json"); await writeFile(path, JSON.stringify(value)); return path;
}
describe("live config", () => {
  it("resolves documented precedence and lists nested credentials", async () => {
    const path = await file({ endpoint: { baseUrl: "http://endpoint.test" }, apiKey: "synthetic-main", workspace: "top", peerName: "top-peer", hosts: { claude_code: { baseUrl: "http://host.test", workspace: "host", peerName: "host-peer", apiKey: "synthetic-nested" }, codex: { apiKey: "synthetic-other" } } });
    const result = await readConfig({}, path);
    expect(result.config).toEqual({ baseUrl: "http://host.test", apiKey: "synthetic-nested", workspace: "host", peerName: "host-peer" });
    expect(result.keys.sort()).toEqual(["synthetic-main", "synthetic-nested", "synthetic-other"]);
    expect(await listConfigKeys(path)).toEqual(result.keys);
    await writeFile(path, JSON.stringify({ apiKey: "rotated" }));
    expect((await readConfig({}, path)).config.apiKey).toBe("rotated");
  });
  it("normalizes /v3 and prefers the Claude key over top-level and Codex", async () => {
    const path = await file({ endpoint: { baseUrl: "https://endpoint.test/v3/" }, apiKey: "top", hosts: { claude_code: { apiKey: "claude" }, codex: { apiKey: "codex-private" } } });
    const result = await readConfig({}, path);
    expect(result.config.baseUrl).toBe("https://endpoint.test"); expect(result.config.apiKey).toBe("claude");
    expect(result.keys).toContain("codex-private");
    expect((await readConfig({ baseUrl: "https://override.test/v3" }, path)).config.baseUrl).toBe("https://override.test");
  });
  it("supports host URL fallback, top-level fields, bb overrides, and key clearing", async () => {
    const path = await file({ workspace: "top", peerName: "person", apiKey: "synthetic", hosts: { claude_code: { baseUrl: "http://host.test" } } });
    expect((await readConfig({}, path)).config).toEqual({ workspace: "top", peerName: "person", apiKey: "synthetic", baseUrl: "http://host.test" });
    const result = await readConfig({ apiKey: "", workspace: "bb", peerName: "bb-peer", baseUrl: "http://bb.test" }, path);
    expect(result.config.apiKey).toBe(""); expect(result.warnings).toHaveLength(4);
    expect(result.warnings.join()).not.toContain("synthetic");
  });
  it("uses defaults for missing files", async () => {
    const path = await file({}); await rm(path);
    expect((await readConfig({}, path)).config).toEqual({ baseUrl: "https://api.honcho.dev", apiKey: "", workspace: "hermes", peerName: "hermy" });
  });
  it("does not echo malformed JSON or credentials in errors", async () => {
    const path = await file({}); await writeFile(path, '{"apiKey":"synthetic-private" broken');
    await expect(readConfig({}, path)).rejects.toThrow(/^Could not read Honcho config JSON\.$/);
    await writeFile(path, JSON.stringify({ endpoint: { baseUrl: "https://user:synthetic-private@example.test" } }));
    await expect(readConfig({}, path)).rejects.toThrow(/^Honcho base URL must/);
  });
  it("enumerates arbitrary hosts and nested credential spellings", () => {
    expect(configKeys({ apiKey: "one", hosts: { other: { api_key: "two", nested: { token: "three" } } } })).toEqual(["one", "two", "three"]);
  });
  it("puts every key in the file, including hosts.codex.apiKey, in the redaction deny set", async () => {
    const path = await file({ apiKey: "top-synthetic-key", hosts: { claude_code: { apiKey: "claude-synthetic-key" }, codex: { apiKey: "codex-synthetic-key" } } });
    const { keys } = await readConfig({}, path);
    const text = "a top-synthetic-key b claude-synthetic-key c codex-synthetic-key";
    expect(redact(text, { deny: keys })).toEqual({ text: "a [REDACTED] b [REDACTED] c [REDACTED]", count: 3 });
  });
  it("uses hosts.claude_code values before top-level ones, field by field", async () => {
    const path = await file({ baseUrl: "http://top.test", workspace: "top", apiKey: "top", hosts: { claude_code: { workspace: "host" } } });
    expect((await readConfig({}, path)).config).toMatchObject({ baseUrl: "http://top.test", workspace: "host", apiKey: "top" });
  });
});

describe("key follows its host", () => {
  it("drops the file key when bb points at another host, unless bb sets the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "honcho-cfg-"));
    try {
      const path = join(dir, "config.json");
      await writeFile(path, JSON.stringify({ baseUrl: "http://one.test", apiKey: "synthetic-file-key" }));
      expect((await readConfig({ baseUrl: "http://two.test" }, path)).config.apiKey).toBe("");
      expect((await readConfig({ baseUrl: "http://one.test/v3" }, path)).config.apiKey).toBe("synthetic-file-key");
      expect((await readConfig({ baseUrl: "http://two.test", apiKey: "synthetic-bb-key" }, path)).config.apiKey).toBe("synthetic-bb-key");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

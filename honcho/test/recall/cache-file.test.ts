import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../../host";
import { appendEntry, normalizePromptText, parseRecallFile, recallFilePath, writeRecallEntry } from "../../lib/recall/cache-file";

const dirs: string[] = [];
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
const temp = async () => { const d = await mkdtemp(join(tmpdir(), "honcho-cache-")); dirs.push(d); return d; };

describe("recall cache file", () => {
  it("normalizes: trim, collapse whitespace, first 500 chars", () => {
    expect(normalizePromptText("  fix\n\n the   build\t ")).toBe("fix the build");
    expect(normalizePromptText(`x ${"a".repeat(600)}`)).toHaveLength(500);
  });
  it("keeps the newest 5 entries with increasing counters and one entry per text", () => {
    let file = parseRecallFile(null);
    for (let i = 1; i <= 7; i++) file = appendEntry(file, { text: `prompt ${i}`, memory: `m${i}`, createdAt: i }).file;
    expect(file.entries.map(e => e.counter)).toEqual([3, 4, 5, 6, 7]);
    file = appendEntry(file, { text: " prompt   5 ", memory: "again", createdAt: 9 }).file;
    expect(file.entries.map(e => [e.counter, e.text])).toEqual([[3, "prompt 3"], [4, "prompt 4"], [6, "prompt 6"], [7, "prompt 7"], [8, "prompt 5"]]);
  });
  it("treats a corrupt or foreign file as empty", () => {
    expect(parseRecallFile("{nope").entries).toEqual([]);
    expect(parseRecallFile(JSON.stringify({ v: 2, entries: [{}] })).entries).toEqual([]);
  });
  it("writes atomically: valid JSON, no tmp files left, rejects path-like thread ids", async () => {
    const dir = await temp();
    await writeFile(join(dir, "thr_a.json"), "garbage");
    const { entry, path } = await writeRecallEntry(dir, "thr_a", { text: "hello  world", memory: "<honcho_memory>x</honcho_memory>", createdAt: 5 });
    expect(entry).toEqual({ counter: 1, text: "hello world", createdAt: 5, memory: "<honcho_memory>x</honcho_memory>" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 1, entries: [entry] });
    expect(await readdir(dir)).toEqual(["thr_a.json"]);
    expect(() => recallFilePath(dir, "../etc/passwd")).toThrow();
  });
});

describe("host entry", () => {
  it("recall.dir is dataDir/recall and keeps the worker warm; dispose releases it", async () => {
    const dataDir = await temp();
    const host = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(dataDir, "t") } });
    expect(await host.experimental_call("recall.dir", {})).toEqual({ dir: join(dataDir, "recall") });
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await host.experimental_call("recall.dir", {});
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await host.experimental_dispose();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  });
  it("serializes concurrent writes for one thread without losing entries", async () => {
    const dataDir = await temp();
    const host = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(dataDir, "t") } });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(i => host.experimental_call("recall.write", { threadId: "thr_w", text: `p${i}`, memory: "", createdAt: i })));
    expect(results.map(r => r.counter).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const file = JSON.parse(await readFile(join(dataDir, "recall", "thr_w.json"), "utf8"));
    expect(file.entries.map((e: { counter: number }) => e.counter)).toEqual([2, 3, 4, 5, 6]);
    await expect(host.experimental_call("recall.write", { threadId: "a/b", text: "x", memory: "", createdAt: 1 })).rejects.toThrow();
    await host.experimental_dispose();
  });
  it("recall.gitCommonDir reports null outside git", async () => {
    const dataDir = await temp();
    const host = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(dataDir, "t") } });
    expect(await host.experimental_call("recall.gitCommonDir", { cwd: dataDir })).toEqual({ commonDir: null });
    await host.experimental_dispose();
  });
});

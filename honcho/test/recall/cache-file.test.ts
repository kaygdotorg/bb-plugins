import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import hostEntry from "../../host";
import { appendEntry, normalizePromptText, parseRecallFile, promptHash, recallFilePath, writeRecallEntry } from "../../lib/recall/cache-file";

const h = (text: string) => promptHash(normalizePromptText(text));

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
    for (let i = 1; i <= 7; i++) file = appendEntry(file, { hash: h(`prompt ${i}`), memory: `m${i}`, createdAt: i }).file;
    expect(file.entries.map(e => e.counter)).toEqual([3, 4, 5, 6, 7]);
    file = appendEntry(file, { hash: h(" prompt   5 "), memory: "again", createdAt: 9 }).file;
    expect(file.entries.map(e => [e.counter, e.hash])).toEqual([[3, h("prompt 3")], [4, h("prompt 4")], [6, h("prompt 6")], [7, h("prompt 7")], [8, h("prompt 5")]]);
  });
  it("treats a corrupt or foreign file as empty", () => {
    expect(parseRecallFile("{nope").entries).toEqual([]);
    expect(parseRecallFile(JSON.stringify({ v: 3, entries: [{}] })).entries).toEqual([]);
    // v1 stored the prompt in plaintext: it is ignored and overwritten.
    expect(parseRecallFile(JSON.stringify({ v: 1, entries: [{ counter: 1, text: "x", createdAt: 1, memory: "m" }] })).entries).toEqual([]);
    expect(parseRecallFile(JSON.stringify({ v: 2, entries: [{ counter: 1, hash: "not-a-hash", createdAt: 1, memory: "m" }] })).entries).toEqual([]);
  });
  it("writes atomically: valid JSON, no tmp files left, rejects path-like thread ids", async () => {
    const dir = await temp();
    await writeFile(join(dir, "thr_a.json"), "garbage");
    const { entry, path } = await writeRecallEntry(dir, "thr_a", { hash: h("hello  world"), memory: "<honcho_memory>x</honcho_memory>", createdAt: 5 });
    expect(entry).toEqual({ counter: 1, hash: h("hello world"), createdAt: 5, memory: "<honcho_memory>x</honcho_memory>" });
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ v: 2, entries: [entry] });
    expect(await readFile(path, "utf8")).not.toContain("hello");
    expect(await readdir(dir)).toEqual(["thr_a.json"]);
    expect(() => recallFilePath(dir, "../etc/passwd")).toThrow();
  });
});

describe("host entry", () => {
  it("recall.write goes to dataDir/recall and keeps the worker warm; dispose releases it", async () => {
    const dataDir = await temp();
    const host = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(dataDir, "t") } });
    const before = Date.now();
    expect((await host.experimental_call("recall.write", { threadId: "thr_d", hash: h("a"), memory: "" })).path).toBe(join(dataDir, "recall", "thr_d.json"));
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await host.experimental_call("recall.write", { threadId: "thr_d", hash: h("b"), memory: "" });
    // createdAt is stamped by the host handler, on the hook's clock; the caller cannot supply one.
    const written = JSON.parse(await readFile(join(dataDir, "recall", "thr_d.json"), "utf8"));
    for (const e of written.entries) expect(e.createdAt).toBeGreaterThanOrEqual(before);
    await expect(host.experimental_call("recall.write", { threadId: "thr_d", hash: h("c"), memory: "", createdAt: 1 } as never)).rejects.toThrow();
    await expect(host.experimental_call("recall.write", { threadId: "thr_d", text: "plain", memory: "" } as never)).rejects.toThrow();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(1);
    await host.experimental_dispose();
    expect(host.experimental_getRetainedWorkerLeaseCount()).toBe(0);
  });
  it("serializes concurrent writes for one thread without losing entries", async () => {
    const dataDir = await temp();
    const host = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(dataDir, "t") } });
    const results = await Promise.all([1, 2, 3, 4, 5, 6].map(i => host.experimental_call("recall.write", { threadId: "thr_w", hash: h(`p${i}`), memory: "" })));
    expect(results.map(r => r.counter).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const file = JSON.parse(await readFile(join(dataDir, "recall", "thr_w.json"), "utf8"));
    expect(file.entries.map((e: { counter: number }) => e.counter)).toEqual([2, 3, 4, 5, 6]);
    await expect(host.experimental_call("recall.write", { threadId: "a/b", hash: h("x"), memory: "" })).rejects.toThrow();
    await host.experimental_dispose();
  });
  it("recall.delete removes the thread's file, serialized after pending writes", async () => {
    const dataDir = await temp();
    const host = experimental_createHostEntryHarness(hostEntry, { experimental_paths: { dataDir, tempDir: join(dataDir, "t") } });
    const write = host.experimental_call("recall.write", { threadId: "thr_x", hash: h("p"), memory: "m" });
    const del = host.experimental_call("recall.delete", { threadId: "thr_x" });
    await write;
    expect(await del).toEqual({ deleted: true });
    expect(await readdir(join(dataDir, "recall"))).toEqual([]);
    expect(await host.experimental_call("recall.delete", { threadId: "thr_x" })).toEqual({ deleted: false });
    await expect(host.experimental_call("recall.delete", { threadId: "../x" })).rejects.toThrow();
    await host.experimental_dispose();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RingActivityLog } from "../lib/activity";
import { redact, REDACTED } from "../lib/redact";
import { createSecretsService, secretRequestPaths } from "../lib/secrets";
import { scanSecrets } from "../lib/secrets-host";

// Synthetic values only (the repo is public).
const LONG = "synthetic-value-0001";
const OTHER = "synthetic-value-0002";
let home: string, dir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "honcho-secrets-"));
  dir = join(home, ".bb", "thread-storage", "thr_x");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); vi.restoreAllMocks(); });

const service = () => createSecretsService({
  host: { call: (async (_op: string, input: { fingerprint?: string }) => scanSecrets(input.fingerprint, { home, env: {} })) as never },
  hostIds: async () => ["host_a"],
});

describe("secrets deny set", () => {
  it("loads dotenv values and redacts them from a transcript", async () => {
    writeFileSync(join(dir, ".env.local"), `SERVICE_NAME=short\nFOO=${LONG}\nexport BAR="${OTHER}" # c\n`);
    writeFileSync(join(dir, ".env.example"), "EXAMPLE=synthetic-example-value\n");
    const values = await service().values();
    expect(values.sort()).toEqual([LONG, OTHER]);
    const out = redact(`curl with ${LONG} and ${OTHER} and short`, { deny: values });
    expect(out.text).toBe(`curl with ${REDACTED} and ${REDACTED} and short`);
    expect(out.count).toBe(2);
  });

  it("skips values shorter than 8 chars", async () => {
    writeFileSync(join(dir, ".env"), "A=1234567\nB=12345678\n");
    expect(await service().values()).toEqual(["12345678"]);
  });

  it("picks up a new value on refresh and an edit (mtime) but not when unchanged", async () => {
    const s = service();
    expect(await s.values()).toEqual([]);
    writeFileSync(join(dir, ".env"), `A=${LONG}\n`);
    await s.refresh();
    expect(await s.values()).toEqual([LONG]);
    writeFileSync(join(dir, ".env"), `A=${OTHER}\n`);
    utimesSync(join(dir, ".env"), new Date(), new Date(Date.now() + 5000));
    await s.refresh();
    expect(await s.values()).toEqual([OTHER]);
    expect((await scanSecrets((await scanSecrets(undefined, { home, env: {} })).fingerprint, { home, env: {} })).values).toBeNull();
  });

  it("reads extra files from BB_HONCHO_SECRET_PATHS", async () => {
    const extra = join(home, "elsewhere.env");
    writeFileSync(extra, `A=${LONG}\n`);
    expect((await scanSecrets(undefined, { home, env: { BB_HONCHO_SECRET_PATHS: extra } })).values).toEqual([LONG]);
  });

  it("keeps the last good set when a host fails, and logs nothing", async () => {
    writeFileSync(join(dir, ".env"), `A=${LONG}\n`);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const activity = new RingActivityLog();
    const add = vi.spyOn(activity, "record");
    let fail = false;
    const s = createSecretsService({
      host: { call: (async (_op: string, input: { fingerprint?: string }) => {
        if (fail) throw new Error(`boom ${LONG}`);
        return scanSecrets(input.fingerprint, { home, env: {} });
      }) as never },
      hostIds: async () => ["host_a"],
    });
    expect(await s.values()).toEqual([LONG]);
    fail = true;
    await s.refresh();
    expect(await s.values()).toEqual([LONG]);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(JSON.stringify(activity.list({} as never))).not.toContain(LONG);
  });

  it("reads dotenv files recorded by secret-request events", async () => {
    const file = join(home, "proj", "creds.env.local");
    mkdirSync(join(home, "proj"));
    writeFileSync(file, `A=${LONG}\n`);
    const event = { type: "system/interaction/lifecycle", payload: { rendererId: "secret-request", resolution: { description: { detail: `${file}\nadded 1` } } } };
    expect(secretRequestPaths(event)).toEqual([file]);
    expect(secretRequestPaths({ payload: { rendererId: "other" } })).toEqual([]);
    const s = createSecretsService({
      host: { call: (async (_op: string, input: { fingerprint?: string; paths?: string[] }) => scanSecrets(input.fingerprint, { home, env: {}, paths: input.paths })) as never },
      hostIds: async () => ["host_a"], paths: async () => [file],
    });
    expect(await s.values()).toEqual([LONG]);
  });

  it("refreshes on the timer", async () => {
    vi.useFakeTimers();
    try {
      const hostIds = vi.fn(async () => [] as string[]);
      const s = createSecretsService({ host: { call: (async () => ({})) as never }, hostIds, intervalMs: 1000 });
      const stop = s.start();
      await vi.advanceTimersByTimeAsync(3000);
      expect(hostIds).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(hostIds).toHaveBeenCalledTimes(3);
    } finally { vi.useRealTimers(); }
  });
});

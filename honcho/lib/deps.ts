import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { ActivityLog, Deps } from "./contract.js";
import { openActivityLog } from "./activity.js";
import { configSignature, defaultConfigPath, readConfig, type ConfigOverrides, type ConfigResult } from "./config.js";
import { HonchoClient, HonchoError } from "./honcho-client.js";
import { openOutbox, type Outbox } from "./outbox.js";
import { defineSettings, type HonchoSettings } from "./settings.js";

export const CLOUD_URL = "https://api.honcho.dev";
export const CONFIG_CACHE_MS = 5_000;

// All settings (connection overrides included) are defined once, in lib/settings.ts.
export { defineSettings, type HonchoSettings } from "./settings.js";

export interface DepsOptions {
  /** The handle from defineSettings(bb); define once per plugin load. */
  settings?: HonchoSettings;
  configPath?: string;
  fetch?: typeof fetch;
  now?: () => number;
  activity?: ActivityLog;
}
export type PluginDeps = Deps & {
  /** Drop the cached config and client, e.g. after the Memory page saved a connection. */
  invalidate(): void;
  /** True when the current connection targets Honcho cloud (a key is then required). */
  isCloud(): Promise<boolean>;
};

/** Opens the database on first use, as the outbox does. */
function lazyActivity(open: () => ActivityLog): ActivityLog {
  let log: ActivityLog | undefined;
  const get = () => log ??= open();
  return { record: e => get().record(e), list: o => get().list(o), subscribe: fn => get().subscribe(fn) };
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;

export function createDeps(bb: Pick<BbPluginApi, "settings" | "storage">, options: DepsOptions = {}): PluginDeps {
  const settings = options.settings ?? defineSettings(bb);
  const path = options.configPath ?? defaultConfigPath();
  const now = options.now ?? Date.now;
  const activity = options.activity ?? lazyActivity(() => openActivityLog(bb.storage));
  let version = 0;
  let cached: { at: number; signature: string; version: number; result: ConfigResult; cloud: boolean } | undefined;
  let loading: Promise<NonNullable<typeof cached>> | undefined;
  let outbox: Outbox | undefined;
  let client: { key: string; value: HonchoClient } | undefined;
  settings.onChange(() => { version++; cached = undefined; client = undefined; loading = undefined; });

  async function load(): Promise<NonNullable<typeof cached>> {
    const startedVersion = version;
    const signature = await configSignature(path);
    const values = await settings.get().catch(() => ({} as Awaited<ReturnType<typeof settings.get>>));
    const preset = values.preset;
    const overrides: ConfigOverrides = {
      baseUrl: text(values.baseUrl), workspace: text(values.workspace), peerName: text(values.peerName), apiKey: text(values.apiKey),
    };
    for (const key of Object.keys(overrides) as Array<keyof ConfigOverrides>) if (overrides[key] === undefined) delete overrides[key];
    let result: ConfigResult;
    try {
      if (preset === "cloud") {
        const inherited = await readConfig({}, path);
        overrides.baseUrl = CLOUD_URL;
        // A key for another server must never be sent to the cloud.
        if (overrides.apiKey === undefined && inherited.config.baseUrl !== CLOUD_URL) overrides.apiKey = "";
      }
      result = await readConfig(overrides, path);
    } catch { throw new HonchoError("validation"); }
    const cloud = preset === "cloud" || (preset === undefined && new URL(result.config.baseUrl).hostname === new URL(CLOUD_URL).hostname);
    return { at: now(), signature, version: startedVersion, result, cloud };
  }
  async function current(): Promise<NonNullable<typeof cached>> {
    // Re-read after the TTL, or earlier when the file or a bb setting changed.
    if (cached && cached.version === version && now() - cached.at < CONFIG_CACHE_MS && cached.signature === await configSignature(path)) return cached;
    const startedVersion = version;
    const pending: Promise<NonNullable<typeof cached>> = loading ??= load().finally(() => { if (loading === pending) loading = undefined; });
    const fresh = await pending;
    if (fresh.version === startedVersion && version === startedVersion) cached = fresh;
    return fresh;
  }

  return {
    activity,
    async config() { return (await current()).result; },
    async client() {
      const { result: { config }, cloud } = await current();
      if (!config.apiKey && cloud) throw new HonchoError("auth");
      const key = JSON.stringify([config.baseUrl, config.apiKey, config.workspace]);
      if (client?.key !== key) client = { key, value: new HonchoClient({ baseUrl: config.baseUrl, apiKey: config.apiKey || undefined, workspace: config.workspace, fetch: options.fetch }) };
      return client.value;
    },
    get outbox() { return outbox ??= openOutbox(bb.storage); },
    invalidate() { cached = undefined; client = undefined; },
    async isCloud() { return (await current()).cloud; },
  };
}

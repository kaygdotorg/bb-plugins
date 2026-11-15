// Every bb setting the plugin has, defined in one bb.settings.define call.
// bb rejects a key defined twice in one load, so slices never define their
// own: server.ts calls defineSettings once and hands out the views below.
import type { BbPluginApi, PluginSettingDescriptor } from "@get-bb/plugin-sdk";
import { clampHookBudget, DEFAULT_HOOK_BUDGET_MS, MAX_HOOK_BUDGET_MS, RECALL_SETTING_DESCRIPTORS, type RecallSettings } from "./recall/ports.js";

/** Connection overrides. Empty values inherit from ~/.honcho/config.json; the file stays the zero-config source. */
export const CONNECTION_SETTING_DESCRIPTORS = {
  preset: { type: "select", label: "Connection", description: "Honcho cloud (key required) or a self-hosted server (key optional). Empty: inferred from the URL.", options: ["cloud", "self-hosted"] },
  baseUrl: { type: "string", label: "Server URL", description: "Overrides the url in ~/.honcho/config.json. Ignored for the cloud preset." },
  workspace: { type: "string", label: "Workspace", description: "Overrides the workspace in ~/.honcho/config.json." },
  peerName: { type: "string", label: "User peer", description: "Overrides the user peer in ~/.honcho/config.json." },
  apiKey: { type: "string", label: "API key", description: "Overrides the key in ~/.honcho/config.json.", secret: true },
} satisfies Record<string, PluginSettingDescriptor>;

export { clampHookBudget, DEFAULT_HOOK_BUDGET_MS, MAX_HOOK_BUDGET_MS };
export const DEFAULT_BACKFILL_RATE = 300;

export const SETTING_DESCRIPTORS = {
  ...CONNECTION_SETTING_DESCRIPTORS,
  ...RECALL_SETTING_DESCRIPTORS,
  captureRequiresSwitchover: {
    type: "boolean" as const, label: "Capture only after switch-over",
    description: "Claude Code and Codex threads are captured only once bb rebuilt their session with the harness honcho integrations off, so nothing is saved twice.",
    default: true,
  },
  backfillMessagesPerMinute: {
    type: "number" as const, label: "Backfill messages per minute",
    description: "Upload rate for the backfill, so live derivation is not starved.",
    default: DEFAULT_BACKFILL_RATE,
  },
} satisfies Record<string, PluginSettingDescriptor>;

export function defineSettings(bb: Pick<BbPluginApi, "settings">) {
  return bb.settings.define(SETTING_DESCRIPTORS);
}
export type HonchoSettings = ReturnType<typeof defineSettings>;
export type HonchoSettingValues = Awaited<ReturnType<HonchoSettings["get"]>>;

/**
 * A synchronous view of the values, kept current by onChange; callbacks that
 * cannot await (configure, provider env) read it.
 *
 * Defaults at load: bb has no synchronous settings read, only the load-safe
 * `get()`. server.ts awaits `ready` inside the (async) factory before it
 * registers configure and the env resolvers, so in production nothing reads
 * the view before the first load. Should the read fail, or anything read the
 * view earlier, it serves the descriptor defaults, which are the safe side:
 * codex gets no bb tools (`codexUseBbTools` false) and the hook waits the
 * default budget. A value from onChange is never overwritten by the slower
 * initial read.
 */
export function settingsView(handle: HonchoSettings) {
  let values: Partial<HonchoSettingValues> = {
    codexUseBbTools: SETTING_DESCRIPTORS.codexUseBbTools.default,
    hookBudgetMs: SETTING_DESCRIPTORS.hookBudgetMs.default,
    captureRequiresSwitchover: SETTING_DESCRIPTORS.captureRequiresSwitchover.default,
    backfillMessagesPerMinute: SETTING_DESCRIPTORS.backfillMessagesPerMinute.default,
  };
  let changed = false;
  handle.onChange(next => { changed = true; values = next; });
  const ready: Promise<void> = handle.get().then(next => { if (!changed) values = next; }, () => undefined);
  const recall: RecallSettings = {
    codexUseBbTools: () => values.codexUseBbTools === true,
    hookBudgetMs: () => clampHookBudget(values.hookBudgetMs),
  };
  return {
    ready,
    recall,
    hookBudgetMs: recall.hookBudgetMs,
    capture: async () => ({ captureRequiresSwitchover: (await handle.get().catch(() => values)).captureRequiresSwitchover !== false }),
    backfillMessagesPerMinute: async () => {
      const rate = (await handle.get().catch(() => values)).backfillMessagesPerMinute;
      return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : DEFAULT_BACKFILL_RATE;
    },
  };
}
export type SettingsView = ReturnType<typeof settingsView>;

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { clampHookBudget, DEFAULT_HOOK_BUDGET_MS, defineSettings, MAX_HOOK_BUDGET_MS, settingsView } from "../lib/settings";

describe("hook budget setting", () => {
  it("has the same maximum as the hook's own cap", () => {
    const hook = readFileSync(new URL("../hooks/bb-honcho-hook.mjs", import.meta.url), "utf8");
    const cap = Number(hook.match(/const MAX_BUDGET_MS = ([\d_]+);/)![1].replace(/_/g, ""));
    expect(MAX_HOOK_BUDGET_MS).toBe(5_000);
    expect(cap).toBe(MAX_HOOK_BUDGET_MS);
  });

  it("clamps what slips through to the cap, and falls back to the default", () => {
    expect(clampHookBudget(650.4)).toBe(650);
    expect(clampHookBudget(0)).toBe(0);
    expect(clampHookBudget(60_000)).toBe(MAX_HOOK_BUDGET_MS);
    for (const bad of [-1, Number.NaN, Infinity, "500", undefined]) expect(clampHookBudget(bad)).toBe(DEFAULT_HOOK_BUDGET_MS);
  });

  it("refuses values above the cap or below zero when saved", async () => {
    const fake = createFakePluginHost({ pluginId: "honcho" });
    const handle = defineSettings(fake.bb);
    await expect(handle.experimental_set({ hookBudgetMs: MAX_HOOK_BUDGET_MS + 1 })).rejects.toThrow();
    await expect(handle.experimental_set({ hookBudgetMs: -5 })).rejects.toThrow();
    await expect(handle.experimental_set({ hookBudgetMs: 1.5 })).rejects.toThrow();
    expect((await handle.experimental_set({ hookBudgetMs: MAX_HOOK_BUDGET_MS })).hookBudgetMs).toBe(MAX_HOOK_BUDGET_MS);
    await fake.harness.lifecycle.dispose();
  });
});

describe("settings view at load", () => {
  it("serves the defaults before the first read, and codex gets no bb tools", () => {
    const listeners: Array<(next: never) => void> = [];
    const handle = { get: () => new Promise<never>(() => undefined), onChange: (fn: (next: never) => void) => { listeners.push(fn); }, experimental_set: async () => ({}) };
    const view = settingsView(handle as never);
    expect(view.recall.codexUseBbTools()).toBe(false);
    expect(view.hookBudgetMs()).toBe(DEFAULT_HOOK_BUDGET_MS);
  });

  it("has the stored values once ready resolves, and onChange wins over a late initial read", async () => {
    const fake = createFakePluginHost({ pluginId: "honcho", settings: { codexUseBbTools: true, hookBudgetMs: 700 } });
    const view = settingsView(defineSettings(fake.bb));
    await view.ready;
    expect(view.recall.codexUseBbTools()).toBe(true);
    expect(view.hookBudgetMs()).toBe(700);

    let resolveGet!: (v: unknown) => void;
    let listener!: (next: unknown) => void;
    const slow = { get: () => new Promise(r => { resolveGet = r; }), onChange: (fn: (next: unknown) => void) => { listener = fn; } };
    const late = settingsView(slow as never);
    listener({ codexUseBbTools: true, hookBudgetMs: 900 });
    resolveGet({ codexUseBbTools: false, hookBudgetMs: 100 });
    await late.ready;
    expect(late.recall.codexUseBbTools()).toBe(true);
    expect(late.hookBudgetMs()).toBe(900);
    await fake.harness.lifecycle.dispose();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { BbPluginApi, ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { registerAcpProviderEnv } from "../../lib/harness";

type Listener = (event: { entity: "system"; type: "changed"; changes: string[] }) => void;

/** A fake bb with a mutable provider list, a realtime subscription and a per-id count of env registrations. */
function fakeBb(initial: string[]) {
  const providers = [...initial];
  const resolvers = new Map<string, () => readonly ExperimentalPluginProviderEnvEntry[]>();
  const contributions = new Map<string, number>();
  const listeners = new Set<Listener>();
  const disposers: Array<() => void> = [];
  const bb = {
    providers: {
      experimental_contributeEnv: (id: string, fn: () => readonly ExperimentalPluginProviderEnvEntry[]) => {
        contributions.set(id, (contributions.get(id) ?? 0) + 1);
        if (resolvers.has(id)) throw new Error(`env resolver for ${id} registered twice`);
        resolvers.set(id, fn);
      },
    },
    sdk: {
      providers: { list: async () => providers.map((id) => ({ id })) },
      subscribe: ({ callback }: { callback: Listener }) => {
        listeners.add(callback);
        return () => { listeners.delete(callback); };
      },
    },
    onDispose: (fn: () => void) => { disposers.push(fn); },
  } as unknown as Pick<BbPluginApi, "providers" | "sdk" | "onDispose">;
  return {
    bb,
    resolvers,
    contributions,
    add: (id: string) => providers.push(id),
    emitProvidersChanged: () => { for (const l of listeners) l({ entity: "system", type: "changed", changes: ["provider-registrations-changed"] }); },
    listenerCount: () => listeners.size,
    dispose: () => { for (const d of disposers) d(); },
  };
}

const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("acp provider env", () => {

  it("gives each acp provider the BB_HONCHO gate at startup and ignores other providers", async () => {
    const f = fakeBb(["codex", "claude-code", "acp-cursor", "acp-opencode"]);
    registerAcpProviderEnv(f.bb);
    await flush();
    expect([...f.resolvers.keys()].sort()).toEqual(["acp-cursor", "acp-opencode"]);
    expect(f.resolvers.get("acp-cursor")!()).toMatchObject([{ name: "BB_HONCHO", value: "1" }]);
    expect(f.resolvers.get("acp-opencode")!()).toMatchObject([{ name: "BB_HONCHO", value: "1" }]);
  });

  it("gives a provider added later its resolver when registrations change", async () => {
    const f = fakeBb(["acp-cursor"]);
    registerAcpProviderEnv(f.bb);
    await flush();
    f.add("acp-hermes");
    f.emitProvidersChanged();
    await flush();
    expect([...f.resolvers.keys()].sort()).toEqual(["acp-cursor", "acp-hermes"]);
  });

  it("never registers an id twice, across events and hourly re-checks", async () => {
    const f = fakeBb(["acp-cursor", "acp-opencode"]);
    registerAcpProviderEnv(f.bb);
    await flush();
    f.emitProvidersChanged();
    f.emitProvidersChanged();
    f.add("acp-omp");
    f.emitProvidersChanged();
    await flush();
    expect(f.contributions.get("acp-cursor")).toBe(1);
    expect(f.contributions.get("acp-opencode")).toBe(1);
    expect(f.contributions.get("acp-omp")).toBe(1);
    expect(f.contributions.size).toBe(3);
  });

  it("stops listening and re-checking once disposed", async () => {
    const f = fakeBb([]);
    registerAcpProviderEnv(f.bb);
    await flush();
    f.dispose();
    expect(f.listenerCount()).toBe(0);
    f.add("acp-late");
    f.emitProvidersChanged();
    await flush();
    expect(f.resolvers.has("acp-late")).toBe(false);
  });
});

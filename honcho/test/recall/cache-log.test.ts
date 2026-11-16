import { describe, expect, it } from "vitest";
import { HonchoError } from "../../lib/honcho-client";
import { MemoryCache } from "../../lib/recall/cache";
import type { RecallShared } from "../../lib/recall/shared";

describe("cache refresh failures", () => {
  it("log one warning per failure streak, and again after a success", async () => {
    let fail = true;
    const shared = {
      peerName: "hermy",
      client: async () => {
        if (fail) throw new HonchoError("timeout");
        return { peer: "hermy", client: {
          listConclusions: async () => ({ items: [] }),
          peerRepresentation: async () => ({ representation: "" }),
        } };
      },
      keyLevel: { get: async () => "workspace-or-admin", noteForbidden() {} },
      ports: { peerCard: async () => [], scopeConclusions: async () => [] },
    } as unknown as RecallShared;
    const logs: string[] = [];
    const cache = new MemoryCache(shared, Date.now, m => logs.push(m));
    for (let i = 0; i < 3; i++) await cache.refresh().catch(() => undefined);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("timeout");
    fail = false;
    await cache.refresh();
    expect(logs).toHaveLength(1);
    fail = true;
    await cache.refresh().catch(() => undefined);
    await cache.refresh().catch(() => undefined);
    expect(logs).toHaveLength(2);
  });
});

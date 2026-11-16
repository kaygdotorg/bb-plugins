import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { PrivacyGate } from "../../lib/recall/privacy";
import { openOutbox } from "../../lib/outbox";
import type { Deps } from "../../lib/contract";

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const f of close.splice(0)) await f(); });
function setup(known: string | null = "client") {
  const f = createFakePluginHost({ pluginId: "honcho" });
  close.push(() => f.harness.lifecycle.dispose());
  const outbox = openOutbox(f.bb.storage);
  const gate = new PrivacyGate(f.bb, { outbox, config: async () => ({ keys: [], config: {}, warnings: [] }) } as unknown as Deps, {
    scopeFor: () => known,
    resolveScope: async () => { known = "client"; return known; },
    isDenied: async () => false,
  });
  return { gate, outbox };
}
const thread = { id: "thread", environmentId: null, projectId: "project" };
it("blocks recall immediately on group pause and resumes without a stale deny cache", async () => {
  const { gate, outbox } = setup();
  expect(await gate.blocked(thread)).toBe(false);
  expect(gate.blockedNow(thread)).toBe(false);
  outbox.setGroupPaused("client", true);
  expect(gate.blockedNow(thread)).toBe(true);
  expect(await gate.blocked(thread)).toBe(true);
  outbox.setGroupPaused("client", false);
  expect(gate.blockedNow(thread)).toBe(false);
  expect(await gate.blocked(thread)).toBe(false);
});
it("fails closed for a new chat until its group has been resolved", async () => {
  const { gate, outbox } = setup(null);
  outbox.setGroupPaused("client", true);
  expect(gate.blockedNow(thread)).toBeNull();
  expect(await gate.blocked(thread)).toBe(true);
  expect(gate.blockedNow(thread)).toBe(true);
});

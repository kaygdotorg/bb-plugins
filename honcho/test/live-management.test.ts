// Opt-in integration test. Only synthetic data in hermes-test; never use the active plugin connection.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { HonchoClient } from "../lib/honcho-client";
import { createGroupService } from "../lib/groups";
import { createKeyService } from "../lib/keys";
import { openOutbox } from "../lib/outbox";
import type { Deps } from "../lib/contract";

it.skipIf(!process.env.HONCHO_TEST_CONFIG)("isolates key minting and group deletion from other groups", async () => {
  const values = Object.fromEntries(readFileSync(process.env.HONCHO_TEST_CONFIG!, "utf8").split("\n").filter(l => l.includes("=")).map(l => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
  if (values.HONCHO_WORKSPACE !== "hermes-test") throw new Error("Live tests require hermes-test.");
  const admin = process.env.HONCHO_TEST_ADMIN_FILE ? JSON.parse(readFileSync(process.env.HONCHO_TEST_ADMIN_FILE, "utf8")).adminKey as string : undefined;
  const config = { baseUrl: values.HONCHO_BASE_URL!, apiKey: values.HONCHO_API_KEY!, workspace: "hermes-test", peerName: "bb-plugin-tester" };
  const client = new HonchoClient(config);
  const f = createFakePluginHost({ pluginId: "honcho", sdk: { threads: { get: async () => { throw new Error("Synthetic sessions have no BB thread."); } } } });
  const deps: Deps = { config: async () => ({ config, keys: [config.apiKey], warnings: [] }), client: async () => client, outbox: openOutbox(f.bb.storage), activity: { record() {}, list: () => [], subscribe: () => () => {} } };
  const id = randomUUID();
  const group = `bb-test-${id}`;
  const target = `bb-target-${id}`;
  const sentinel = `bb-sentinel-${id}`;
  try {
    await client.getOrCreateSession(target, { scopes: [group], peers: { [config.peerName]: { observe_me: false } } });
    await client.getOrCreateSession(sentinel, { scopes: [`bb-keep-${id}`], peers: { [config.peerName]: { observe_me: false } } });
    for (const session of [target, sentinel]) await client.createMessages(session, [{ content: "TESTER synthetic plugin integration fixture", peer_id: config.peerName, configuration: { reasoning: { enabled: false } } }]);
    await client.createConclusions([{ content: "TESTER synthetic target fact", observer_id: config.peerName, observed_id: config.peerName, session_id: target }]);
    if (admin) {
      const keys = createKeyService(f.bb, deps);
      const minted = await keys.mint({ label: "Synthetic integration test", workspace: "hermes-test", peer: config.peerName, adminKey: admin, expiresAt: new Date(Date.now() + 3600000).toISOString() });
      // Assert only a boolean so failed checks never print the credential.
      expect(typeof minted.key === "string" && minted.key.length > 0).toBe(true);
      expect((await keys.view()).notes).toHaveLength(1);
      const denied = await fetch(`${config.baseUrl.replace(/\/v3$/, "")}/v3/workspaces/hermes/sessions/list`, { method: "POST", headers: { authorization: `Bearer ${minted.key}`, "content-type": "application/json" }, body: "{}" });
      expect([401, 403].includes(denied.status)).toBe(true);
      await denied.body?.cancel();
    }
    const groups = createGroupService(f.bb, deps);
    const plan = await groups.preview(group);
    expect(plan.sessions).toBe(1);
    expect(plan.messages).toBe(1);
    expect(plan.conclusions).toBe(1);
    await groups.forget(group, group, plan.token);
    expect(deps.outbox.groupPaused(group)).toBe(true);
    expect((await client.listScopeSessions(group)).items.filter(s => s.is_active)).toHaveLength(0);
    expect((await client.listMessages(sentinel)).items).toHaveLength(1);
  } finally {
    for (const session of [target, sentinel]) await client.deleteSession(session).catch(() => {});
    await f.harness.lifecycle.dispose();
  }
}, 60_000);

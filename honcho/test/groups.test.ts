import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { Deps } from "../lib/contract";
import { completePages, createGroupService } from "../lib/groups";
import { openOutbox } from "../lib/outbox";

const open: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of open.splice(0)) await close(); });
function setup() {
  const f = createFakePluginHost({ pluginId: "honcho" });
  open.push(() => f.harness.lifecycle.dispose());
  const outbox = openOutbox(f.bb.storage);
  let count = 2;
  let connection = "test";
  const deleted: string[] = [];
  const own = { id: "own", source_ids: [] };
  const client = {
    listScopeSessions: vi.fn(async () => ({ items: [{ id: "session", is_active: true }], total: 1 })),
    listMessages: vi.fn(async () => ({ items: [], total: count })),
    listConclusions: vi.fn(async (filter: { session_id?: string }) => ({ items: filter.session_id ? [own] : [own, { id: "child", source_ids: ["own"] }, { id: "grandchild", source_ids: ["child"] }, { id: "unrelated", source_ids: ["other"] }], pages: 1 })),
    deleteSession: vi.fn(async (id: string) => { deleted.push(id); }),
    deleteConclusion: vi.fn(async (id: string) => { deleted.push(id); }),
  };
  const deps = { client: async () => client, config: async () => ({ config: { baseUrl: "https://honcho.example.org", workspace: connection }, keys: [] }), outbox, activity: { record: vi.fn() } } as unknown as Deps;
  return { service: createGroupService(f.bb, deps), client, outbox, deleted, changed: () => { count++; }, switched: () => { connection = "different"; } };
}
describe("group deletion", () => {
  it("dry run changes nothing, then deletes exactly the sessions and transitive source-linked conclusions", async () => {
    const s = setup();
    const preview = await s.service.preview("client");
    expect(preview).toMatchObject({ sessions: 1, messages: 2, conclusions: 3 });
    expect(s.deleted).toEqual([]);
    await s.service.forget("client", "client", preview.token);
    expect(s.deleted).toEqual(["session", "child", "grandchild", "own"]);
    expect(s.outbox.groupPaused("client")).toBe(true);
    expect(s.deleted).not.toContain("unrelated");
    await expect(s.service.forget("client", "client", preview.token)).rejects.toThrow("Preview");
  });
  it("requires exact typed confirmation and rejects stale counts or connection changes", async () => {
    const s = setup(); const preview = await s.service.preview("client");
    await expect(s.service.forget("client", "wrong", preview.token)).rejects.toThrow("exact name");
    s.changed();
    await expect(s.service.forget("client", "client", preview.token)).rejects.toThrow("changed");
    expect(s.deleted).toEqual([]);
    const next = await s.service.preview("client"); s.switched();
    await expect(s.service.forget("client", "client", next.token)).rejects.toThrow("changed");
    expect(s.deleted).toEqual([]);
  });
  it("does not race an in-flight capture upload", async () => {
    const s = setup(); const preview = await s.service.preview("client");
    s.outbox.acquireLease("session", "capture", Date.now(), 60_000);
    await expect(s.service.forget("client", "client", preview.token)).rejects.toThrow("remains paused");
    expect(s.deleted).toEqual([]);
    expect(s.outbox.leaseOwner("session", Date.now())).toBe("capture");
  });
  it("refuses incomplete pagination instead of generating a partial deletion plan", async () => {
    await expect(completePages(async () => ({ items: [1, 2], pages: 10 }), 2)).rejects.toThrow("scan completely");
  });
  it("retains the pause after a partial deletion failure", async () => {
    const s = setup(); const preview = await s.service.preview("client");
    s.client.deleteConclusion.mockRejectedValueOnce(new Error("unavailable"));
    await expect(s.service.forget("client", "client", preview.token)).rejects.toThrow("remains paused");
    expect(s.outbox.groupPaused("client")).toBe(true);
    expect(s.outbox.leaseOwner("session", Date.now())).toBeUndefined();
  });
});
describe("group pause history", () => {
  it("keeps unsent and paused messages out after resume, including new chats in the group", () => {
    const { outbox } = setup();
    outbox.setGroupPaused("client", true, 100);
    expect(outbox.groupAllows("client", 80, 110)).toBe(false);
    expect(outbox.groupAllows("client", 105, 110)).toBe(false);
    expect(outbox.groupAllows("other", 105, 110)).toBe(true);
    outbox.setGroupPaused("client", false, 200);
    expect(outbox.groupAllows("client", 105, 210)).toBe(false);
    expect(outbox.groupAllows("client", 80, 210)).toBe(false);
    expect(outbox.groupAllows("client", 201, 210)).toBe(true);
  });
});

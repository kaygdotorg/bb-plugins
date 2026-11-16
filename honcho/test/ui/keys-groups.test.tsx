// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

afterEach(cleanup);
async function page(subPath: string, rpc: Record<string, (input: any) => unknown>) {
  const app = await loadPluginApp(() => import("../../app"));
  return renderSlot(app.navPanels[0]!, { subPath }, { rpc: rpc as never });
}
it("shows a newly created key only until dismissed and clears the temporary admin input", async () => {
  const s = await page("keys", {
    "keys.get": () => ({ source: "config-file", level: "workspace", workspace: "test", activeWorkspace: "test", expiresAt: null, notes: [] }),
    "keys.mint": () => ({ key: "synthetic-created-value" }),
  });
  fireEvent.change(await s.findByLabelText("Admin key for this request"), { target: { value: "synthetic-admin" } });
  fireEvent.change(s.getByLabelText("Label"), { target: { value: "Bot" } });
  fireEvent.click(s.getByRole("button", { name: "Create key" }));
  expect(await s.findByLabelText("New key")).toHaveProperty("value", "synthetic-created-value");
  fireEvent.click(s.getByText("I’ve saved it"));
  expect(s.queryByLabelText("New key")).toBeNull();
  expect(s.getByLabelText("Admin key for this request")).toHaveProperty("value", "");
});
it("requires a preview and exact group name before issuing a destructive RPC", async () => {
  let deletes = 0;
  const s = await page("groups", {
    "groups.list": () => [{ id: "client", chats: 1, lastActivity: null, paused: false }],
    "groups.get": () => ({ summary: "Synthetic summary", paused: false, chats: [] }),
    "groups.forgetPreview": () => ({ token: "preview", sessions: 1, messages: 2, conclusions: 3, group: "client", expiresAt: Date.now() + 300000 }),
    "groups.forget": () => { deletes++; return { ok: true }; },
  });
  fireEvent.click(await s.findByRole("button", { name: /client/ }));
  fireEvent.click(await s.findByText("Check what would be removed"));
  const confirm = await s.findByLabelText("Type client to confirm");
  expect((s.getByText("Forget permanently") as HTMLButtonElement).disabled).toBe(true);
  expect(deletes).toBe(0);
  fireEvent.change(confirm, { target: { value: "client" } });
  fireEvent.click(s.getByText("Forget permanently"));
  await waitFor(() => expect(deletes).toBe(1));
});

import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createKeyService, keyClaims } from "../lib/keys";
import { defineSettings } from "../lib/settings";
import type { Deps } from "../lib/contract";

const token = (claims: object) => ["header", Buffer.from(JSON.stringify(claims)).toString("base64url"), "signature"].join(".");
describe("key management", () => {
  function setup(fetch: typeof globalThis.fetch) {
    const { bb, harness } = createFakePluginHost({ pluginId: "honcho" });
    const settings = defineSettings(bb);
    const fileKey = token({ w: "test" });
    const deps = { config: async () => ({ config: { baseUrl: "https://honcho.example.org", apiKey: (await settings.get()).apiKey || fileKey, workspace: "test", peerName: "user" }, warnings: [], keys: [] }) } as unknown as Deps;
    return { bb, harness, settings, service: createKeyService(bb, deps, settings, fetch) };
  }
  it("handles opaque, malformed and extreme expiry claims without exposing them", () => {
    expect(keyClaims("opaque")).toEqual({ level: "unknown", workspace: null, expiresAt: null });
    expect(keyClaims(token({ ad: true, exp: 1e30 }))).toEqual({ level: "admin", workspace: null, expiresAt: null });
    expect(keyClaims(token({ w: "test", sc: "client", exp: 1800000000 }))).toMatchObject({ level: "group", workspace: "test" });
  });
  it("tests replacements before persisting, and unsets the override to restore the file", async () => {
    let accepted = false;
    const fetch = vi.fn(async () => new Response(accepted ? JSON.stringify({ items: [] }) : "never expose response content", { status: accepted ? 200 : 401 })) as unknown as typeof globalThis.fetch;
    const s = setup(fetch);
    try {
      await expect(s.service.replace("rejected-value")).rejects.toThrow("Nothing was changed");
      expect((await s.settings.get()).apiKey).toBeUndefined();
      accepted = true;
      await s.service.replace("accepted-value");
      expect((await s.settings.get()).apiKey).toBe("accepted-value");
      await s.service.replace(null);
      expect((await s.settings.get()).apiKey).toBeUndefined();
    } finally { await s.harness.lifecycle.dispose(); }
  });
  it("creates once, uses the temporary admin key, and stores only notes", async () => {
    const minted = token({ w: "test", p: "bot" });
    const fetch = vi.fn(async () => new Response(JSON.stringify({ key: minted }))) as unknown as typeof globalThis.fetch;
    const s = setup(fetch);
    try {
      expect(await s.service.mint({ label: "Bot", workspace: "test", peer: "bot", adminKey: "temporary-admin" })).toEqual({ key: minted });
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, options] = vi.mocked(fetch).mock.calls[0]!;
      expect(String(url)).toContain("/v3/keys?workspace_id=test&peer_id=bot");
      expect((options!.headers as Record<string, string>).authorization).toBe("Bearer temporary-admin");
      const view = await s.service.view();
      expect(view.notes).toHaveLength(1);
      expect(JSON.stringify(view)).not.toContain(minted);
      expect(JSON.stringify(view)).not.toContain("temporary-admin");
      expect((await s.settings.get()).apiKey).toBeUndefined();
    } finally { await s.harness.lifecycle.dispose(); }
  });
  it("rejects conflicting scopes and past expiry before any request", async () => {
    const fetch = vi.fn() as unknown as typeof globalThis.fetch;
    const s = setup(fetch);
    try {
      await expect(s.service.mint({ label: "Bad", workspace: "test", peer: "bot", scope: "client" })).rejects.toThrow("cannot also");
      await expect(s.service.mint({ label: "Bad", workspace: "test", expiresAt: "2020-01-01" })).rejects.toThrow("future");
      expect(fetch).not.toHaveBeenCalled();
    } finally { await s.harness.lifecycle.dispose(); }
  });
  it("never retries minting after a server failure", async () => {
    const fetch = vi.fn(async () => new Response("private error", { status: 500 })) as unknown as typeof globalThis.fetch;
    const s = setup(fetch);
    try {
      await expect(s.service.mint({ label: "Bot", workspace: "test" })).rejects.toThrow("Could not create");
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await s.harness.lifecycle.dispose(); }
  });
});

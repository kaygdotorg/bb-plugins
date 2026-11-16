import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { experimental_PluginRpcRefusal } from "@get-bb/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import type { Deps, KeyNote, KeyView, MintKeyInput } from "./contract.js";
import { HonchoClient } from "./honcho-client.js";
import type { HonchoSettings } from "./settings.js";

/** Claims describe a credential; only the server verifies its authority. Never return raw claims. */
export function keyClaims(key: string): Pick<KeyView, "level" | "workspace" | "expiresAt"> {
  try {
    const c = JSON.parse(Buffer.from(key.split(".")[1]!, "base64url").toString("utf8"));
    return {
      level: c.ad === true ? "admin" : typeof c.sc === "string" ? "group" : typeof c.s === "string" ? "session" : typeof c.p === "string" ? "assistant" : typeof c.w === "string" ? "workspace" : "unknown",
      workspace: typeof c.w === "string" ? c.w : null,
      expiresAt: typeof c.exp === "number" && Number.isFinite(c.exp) && Math.abs(c.exp) < 8e12 ? new Date(c.exp * 1000).toISOString() : null,
    };
  } catch { return { level: "unknown", workspace: null, expiresAt: null }; }
}

const NOTES = "keys.notes";
const refuse = (message: string): never => { throw new experimental_PluginRpcRefusal({ code: "invalid", message }); };
export function createKeyService(bb: Pick<BbPluginApi, "storage">, deps: Deps, settings?: HonchoSettings, transport?: typeof fetch) {
  // Serialize note writes so simultaneous creates cannot overwrite one another.
  let writes = Promise.resolve();
  const connectionId = (baseUrl: string) => createHash("sha256").update(baseUrl).digest("hex");
  async function view(): Promise<KeyView> {
    const { config, warnings } = await deps.config();
    const values = await settings?.get();
    const source = values?.apiKey?.trim() ? "bb-secret" : warnings.some(w => w.startsWith("bb apiKey")) ? "bb-secret" : config.apiKey ? "config-file" : "none";
    const all = await bb.storage.kv.get<Array<KeyNote & { connection: string }>>(NOTES) ?? [];
    return { ...keyClaims(config.apiKey), source, activeWorkspace: config.workspace, notes: all.filter(n => n.connection === connectionId(config.baseUrl)).map(({ connection: _, ...n }) => n) };
  }
  async function replace(apiKey: string | null) {
    if (!settings) return refuse("Key settings are unavailable.");
    if (apiKey !== null) {
      const { config } = await deps.config();
      try { await new HonchoClient({ ...config, apiKey, fetch: transport }).probeKeyLevel(); }
      catch { return refuse("The new key could not access this workspace. Nothing was changed."); }
    }
    await settings.experimental_set({ apiKey });
    return { ok: true } as const;
  }
  async function mint(input: MintKeyInput): Promise<{ key: string }> {
    if (input.scope && (input.peer || input.session)) return refuse("A group key cannot also target an assistant or chat.");
    if (input.expiresAt && (!Number.isFinite(Date.parse(input.expiresAt)) || Date.parse(input.expiresAt) <= Date.now())) return refuse("Choose an expiry in the future.");
    const { config } = await deps.config();
    let result: { key: string };
    try {
      // An optional admin key is used only for this request, never stored in settings, notes or activity.
      result = await new HonchoClient({ ...config, apiKey: input.adminKey || config.apiKey, fetch: transport }).createKey(input);
      if (typeof result.key !== "string" || !result.key) throw new Error();
    } catch { return refuse("Could not create the key. Check admin access and the requested scope."); }
    const note = { id: randomUUID(), label: input.label, workspace: input.workspace, peer: input.peer ?? null, session: input.session ?? null, scope: input.scope ?? null, expiresAt: input.expiresAt ?? null, createdAt: Date.now(), connection: connectionId(config.baseUrl) };
    // The result is delivered once, even if local note storage fails: never lose a minted credential.
    const write = writes.then(async () => { const notes = await bb.storage.kv.get<typeof note[]>(NOTES) ?? []; await bb.storage.kv.set(NOTES, [note, ...notes].slice(0, 100)); });
    writes = write.catch(() => {});
    await writes;
    return result;
  }
  return { view, replace, mint };
}

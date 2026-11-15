import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ConnectionConfig { baseUrl: string; apiKey: string; workspace: string; peerName: string }
export type ConfigOverrides = Partial<ConnectionConfig>;
export interface ConfigResult { config: ConnectionConfig; keys: string[]; warnings: string[] }
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** Credential values at any nesting depth, never property names. */
export function configKeys(file: unknown): string[] {
  const keys = new Set<string>();
  const visit = (value: unknown) => {
    for (const [name, child] of Object.entries(object(value))) {
      if (/^(?:api[_-]?key|token|bearer[_-]?token|secret|password)$/i.test(name) && typeof child === "string" && child) keys.add(child);
      if (child && typeof child === "object") visit(child);
    }
  };
  visit(file);
  return [...keys];
}
export const defaultConfigPath = () => join(homedir(), ".honcho", "config.json");
async function readConfigFile(path: string): Promise<ObjectValue> {
  try { return object(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    // Neither parser diagnostics nor filesystem paths can safely be echoed.
    throw new Error("Could not read Honcho config JSON.");
  }
}
/** Cheap change detector (mtime + size; "missing" when absent), so callers can re-read only after an edit. */
export async function configSignature(path = defaultConfigPath()): Promise<string> {
  try { const s = await stat(path); return `${s.mtimeMs}:${s.size}`; } catch { return "missing"; }
}
export async function listConfigKeys(path = defaultConfigPath()): Promise<string[]> {
  return configKeys(await readConfigFile(path));
}
function sameOrigin(a: string, b: string): boolean | undefined {
  try { return new URL(a).origin === new URL(b).origin; } catch { return undefined; }
}
/** No memoization: key rotations and edits take effect on the next call.
 * undefined means inherit; an explicit empty key supports unauthenticated hosts. */
export async function readConfig(overrides: ConfigOverrides = {}, path = defaultConfigPath()): Promise<ConfigResult> {
  const file = await readConfigFile(path);
  const host = object(object(file.hosts).claude_code);
  const inherited: ConnectionConfig = {
    baseUrl: string(host.baseUrl) ?? string(object(file.endpoint).baseUrl) ?? string(file.baseUrl) ?? "https://api.honcho.dev",
    apiKey: string(host.apiKey) ?? string(file.apiKey) ?? "",
    workspace: string(host.workspace) ?? string(file.workspace) ?? "hermes",
    peerName: string(host.peerName) ?? string(file.peerName) ?? "hermy",
  };
  const config = { ...inherited };
  const warnings: string[] = [];
  for (const key of Object.keys(inherited) as Array<keyof ConnectionConfig>) {
    if (overrides[key] !== undefined) {
      config[key] = overrides[key]!;
      if (config[key] !== inherited[key]) warnings.push(`bb ${key} overrides the Honcho file setting.`);
    }
  }
  config.baseUrl = config.baseUrl.replace(/\/+$/, "").replace(/\/v3$/, "");
  // A key belongs to the host it came from: never carry the file's key to another host.
  if (overrides.apiKey === undefined && config.apiKey && sameOrigin(config.baseUrl, inherited.baseUrl) === false) {
    config.apiKey = "";
    warnings.push("The Honcho file key was not sent to the bb base URL, which is a different host.");
  }
  try {
    const url = new URL(config.baseUrl);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new Error("Honcho base URL must be HTTP(S) without embedded credentials."); }
  return { config, keys: [...new Set([...configKeys(file), config.apiKey].filter(Boolean))], warnings };
}

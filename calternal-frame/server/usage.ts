/**
 * Pooled Claude/Codex usage for the sidebar bars. Reads the CLIProxyAPI Usage plugin's
 * snapshot through bb's cross-plugin RPC, so the CLIProxyAPI management key stays in that
 * plugin. Pooled = the mean share used across accounts that report a window.
 */
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { cliproxySnapshotSchema, type CliproxySnapshot, type UsageSummary, type UsageWindow } from "../shared/contract";

const CACHE_MS = 30_000;

/** Pools one account-wide window ("Session" or "Weekly"; not per-model ones like "Weekly · Opus"). */
function pool(accounts: CliproxySnapshot["accounts"], label: "Session" | "Weekly"): UsageWindow | null {
  const used: number[] = [];
  const resets: string[] = [];
  for (const account of accounts) {
    const bucket = account.groups.find((g) => g.name === label)?.buckets[0];
    if (!bucket) continue;
    used.push(1 - bucket.remainingFraction);
    if (bucket.resetTime) resets.push(bucket.resetTime);
  }
  if (used.length === 0) return null;
  resets.sort((a, b) => Date.parse(a) - Date.parse(b));
  return { used: used.reduce((sum, v) => sum + v, 0) / used.length, accounts: used.length, resetsAt: resets[0] ?? "" };
}

export function createUsage(bb: BbPluginApi) {
  let cache: { at: number; value: UsageSummary } | null = null;

  return async function summary(refresh: boolean): Promise<UsageSummary> {
    if (!refresh && cache && Date.now() - cache.at < CACHE_MS) return cache.value;
    try {
      const snapshot = await bb.sdk.plugins.callRpc({
        pluginId: "cliproxy-usage",
        method: "usage_read",
        input: { refresh },
        outputSchema: cliproxySnapshotSchema as never,
      }) as CliproxySnapshot;
      if (snapshot.status !== "connected") {
        return { status: "unavailable", message: snapshot.message ?? "CLIProxyAPI is not connected.", providers: [] };
      }
      const providers = (["claude", "codex"] as const).flatMap((provider) => {
        const accounts = snapshot.accounts.filter((a) => a.provider.toLowerCase() === provider && a.state !== "disabled");
        return accounts.length === 0 ? [] : [{
          provider,
          accounts: accounts.length,
          session: pool(accounts, "Session"),
          weekly: pool(accounts, "Weekly"),
        }];
      });
      const value: UsageSummary = { status: "ok", message: null, providers };
      cache = { at: Date.now(), value };
      return value;
    } catch (error) {
      return {
        status: "unavailable",
        message: error instanceof Error
          ? `${error.message} (the CLIProxyAPI Usage plugin provides this data)`
          : "Install and configure the CLIProxyAPI Usage plugin.",
        providers: [],
      };
    }
  };
}

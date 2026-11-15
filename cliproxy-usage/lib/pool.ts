/**
 * Pools many accounts of one provider into one number per quota window, for the compact
 * footer display. Pooled = the mean share used across the accounts that report the window;
 * the reset shown is the soonest one.
 */
import type { UsageSnapshot, UsageSummary, UsageWindow } from "../server";

/** Account-wide windows only ("Session", "Weekly"), not per-model ones like "Weekly · Opus". */
function pool(accounts: UsageSnapshot["accounts"], label: "Session" | "Weekly"): UsageWindow | null {
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

export function summarize(snapshot: UsageSnapshot): UsageSummary {
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
  return { status: "ok", message: null, providers };
}

/**
 * Pooled Claude/Codex usage as one item in bb's sidebar footer row, next to its icons:
 * the providers side by side on one line, each [icon or name] [%].
 * Data: the usage_summary RPC (server/usage.ts), polled once a minute.
 */
import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, UsagePrefs, UsageSummary, UsageWindow } from "../shared/contract";

function resetLabel(iso: string): string | null {
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** Text colour by how full the window is. */
function tone(used: number): string {
  return used >= 0.9 ? "text-destructive" : used >= 0.75 ? "text-warning" : "text-muted-foreground";
}

type ProviderUsage = UsageSummary["providers"][number];

const PROVIDER_NAMES = { claude: "Claude", codex: "Codex" } as const;
/** bb's own provider logos, drawn as a mask so they take the text colour. */
const LOGO_URLS = {
  claude: "/api/v1/system/providers/claude-code/logo",
  codex: "/api/v1/system/providers/codex/logo",
} as const;

function ProviderIcon({ provider }: { provider: ProviderUsage["provider"] }) {
  const mask = `url(${LOGO_URLS[provider]}) center / contain no-repeat`;
  return <span aria-hidden="true" className="inline-block size-3 shrink-0 text-muted-foreground" style={{ mask, WebkitMask: mask, backgroundColor: "currentColor" }} />;
}

const percentOf = (w: UsageWindow) => Math.round(w.used * 100);

/** One compact row: [label or icon] [thin bar] [optional %]. */
function UsageBar({ provider, prefs }: { provider: ProviderUsage; prefs: UsagePrefs }) {
  const name = PROVIDER_NAMES[provider.provider];
  const { session, weekly } = provider;
  const shown = prefs.window === "session" ? session : prefs.window === "weekly" ? weekly : (session ?? weekly);
  const pct = shown ? percentOf(shown) : null;
  const reset = shown ? resetLabel(shown.resetsAt) : null;
  const title = [
    `${name}: ${provider.accounts} account${provider.accounts === 1 ? "" : "s"}, pooled`,
    session ? `5h session ${percentOf(session)}% used across ${session.accounts}` : null,
    weekly ? `weekly ${percentOf(weekly)}% used across ${weekly.accounts}` : null,
    reset ? `next reset in ${reset}` : null,
  ].filter(Boolean).join(" \u00b7 ");

  return (
    <div className={`flex h-3.5 shrink-0 items-center gap-1 text-[10px] leading-none text-sidebar-foreground ${shown ? "" : "opacity-50"}`} title={title}>
      {prefs.showIcons ? (
        <ProviderIcon provider={provider.provider} />
      ) : (
        <span className="w-9 shrink-0 truncate text-muted-foreground">{name}</span>
      )}
      {/* The footer row is narrow: a percentage says it all; colour marks the danger zones. */}
      <span
        role="meter"
        aria-label={`${name} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct ?? undefined}
        aria-valuetext={pct === null ? "No data" : `${pct}%`}
        className={`shrink-0 tabular-nums ${shown ? tone(shown.used) : "text-muted-foreground"}`}
      >
        {pct === null ? "\u2014" : `${pct}%`}
      </span>
    </div>
  );
}

export function UsageBars({ prefs }: { prefs: UsagePrefs }) {
  const rpc = useRpc<typeof rpcContract>();
  const [summary, setSummary] = useState<UsageSummary | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => rpc.call("usage_summary", { refresh: false })
      .then((value) => { if (alive) setSummary(value); })
      .catch(() => { if (alive) setSummary({ status: "unavailable", message: null, providers: [] }); });
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [rpc]);

  if (!prefs.enabled) return null;
  if (!summary || summary.providers.length === 0) {
    return summary?.status === "unavailable" ? (
      <span className="text-[10px] text-muted-foreground" title={summary.message ?? undefined}>Usage unavailable</span>
    ) : null;
  }
  return (
    <div className="flex w-full min-w-0 flex-row items-center justify-end gap-3">
      {summary.providers.map((provider) => <UsageBar key={provider.provider} provider={provider} prefs={prefs} />)}
    </div>
  );
}


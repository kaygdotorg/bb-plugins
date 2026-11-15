import { useCallback, useEffect, useState } from "react";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, UsageSnapshot } from "./server";
import { FooterUsage } from "./footer";

function formatProvider(provider: string): string {
  const normalized = provider.toLowerCase();
  if (normalized === "claude" || normalized === "anthropic") return "Claude";
  if (normalized === "codex" || normalized === "openai") return "Codex";
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

function formatReset(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : `Resets ${date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
}

function formatMetric(metric: UsageSnapshot["accounts"][number]["metrics"][number]): string {
  if (metric.format === "currency" && metric.currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: metric.currency,
        maximumFractionDigits: 2,
      }).format(metric.value);
    } catch {
      // Fall back to the provider's plain numeric value when its currency is unknown.
    }
  }
  return `${metric.value.toLocaleString()}${metric.unit ? ` ${metric.unit}` : ""}`;
}

function QuotaBucket({ bucket }: { bucket: UsageSnapshot["accounts"][number]["groups"][number]["buckets"][number] }) {
  const remaining = Math.round(bucket.remainingFraction * 100);
  const consumed = 100 - remaining;
  const fillColor = remaining <= 10
    ? "bg-destructive"
    : remaining <= 20
      ? "bg-warning"
      : "bg-primary";
  const label = bucket.description || bucket.window || "Usage";
  const reset = formatReset(bucket.resetTime);

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-medium">{label}</span>
        <span className="shrink-0 text-sm font-semibold tabular-nums">{remaining}% left</span>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={`${label} quota remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={remaining}
      >
        <div className={`h-full rounded-full transition-[width] ${fillColor}`} style={{ width: `${consumed}%` }} />
      </div>
      {reset ? <p className="text-2xs text-muted-foreground">{reset}</p> : null}
    </div>
  );
}

function AccountCard({ account }: { account: UsageSnapshot["accounts"][number] }) {
  const stateLabel = account.state === "available" ? "Live"
    : account.state === "observed" ? "Observed"
      : account.state === "disabled" ? "Disabled"
        : account.state === "unsupported" ? "No quota data"
          : "Unavailable";
  const observedLabel = account.observedAt
    ? `Observed ${new Date(account.observedAt).toLocaleTimeString()}`
    : null;

  return (
    <article className="rounded-lg border border-sidebar-border bg-sidebar px-3 py-2.5">
      <header className="mb-2.5 flex items-start gap-2">
        <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sidebar-accent text-xs font-semibold text-sidebar-foreground">
          {formatProvider(account.provider).slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold">{account.email || formatProvider(account.provider)}</div>
          <div className="truncate text-2xs text-muted-foreground">
            {account.plan ? `${formatProvider(account.provider)} · ${account.plan}` : formatProvider(account.provider)}
          </div>
        </div>
        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-2xs ${account.state === "available" ? "bg-primary/15 text-primary" : account.state === "observed" ? "bg-warning/15 text-warning" : "bg-muted text-muted-foreground"}`}>
          {stateLabel}
        </span>
      </header>

      {account.groups.length > 0 ? (
        <div className="space-y-3">
          {account.groups.map((group, index) => (
            <section key={`${group.name}-${index}`} className="space-y-2 border-t border-sidebar-border pt-2 first:border-t-0 first:pt-0">
              {group.name ? <h3 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">{group.name}</h3> : null}
              {group.buckets.map((bucket, bucketIndex) => (
                <QuotaBucket key={`${bucket.window}-${bucketIndex}`} bucket={bucket} />
              ))}
            </section>
          ))}
        </div>
      ) : null}

      {account.metrics.length > 0 ? (
        <dl className={`${account.groups.length > 0 ? "mt-3 border-t border-sidebar-border pt-2" : ""} grid grid-cols-2 gap-2`}>
          {account.metrics.map((metric, index) => (
            <div key={`${metric.label}-${index}`} className="min-w-0">
              <dt className="truncate text-2xs text-muted-foreground">{metric.label}</dt>
              <dd className="truncate text-xs font-medium tabular-nums">{formatMetric(metric)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {observedLabel ? <p className="mt-2 text-2xs text-muted-foreground">{observedLabel}</p> : null}

      {account.state !== "available" ? (
        <p className="text-xs text-muted-foreground">{account.message}</p>
      ) : account.groups.length === 0 && account.metrics.length === 0 ? (
        <p className="text-xs text-muted-foreground">No quota windows were returned for this account.</p>
      ) : null}
    </article>
  );
}

function UsageDisclosure({ dismiss }: { dismiss(): void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<UsageSnapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async (force: boolean) => {
    setLoading(true);
    try {
      setSnapshot(await rpc.call("usage_read", { refresh: force }));
    } catch (error) {
      setSnapshot({
        status: "error",
        message: error instanceof Error ? error.message : "Usage could not be loaded.",
        accounts: [],
        observedAt: null,
      });
    } finally {
      setLoading(false);
    }
  }, [rpc]);

  useEffect(() => {
    void refresh(false);
    const timer = window.setInterval(() => void refresh(false), 60_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const providers = [...new Set(snapshot?.accounts.map((account) => account.provider) ?? [])];
  const accountCount = snapshot?.accounts.length ?? 0;

  return (
    <section className="flex max-h-[min(70vh,36rem)] flex-col border-b border-sidebar-border bg-sidebar text-sidebar-foreground">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-sidebar-border px-3">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">Provider usage</span>
        <span className="shrink-0 text-2xs text-muted-foreground">
          {snapshot?.status === "connected"
            ? `${accountCount} account${accountCount === 1 ? "" : "s"}`
            : snapshot?.status === "error" ? "Unavailable" : "Loading"}
        </span>
        <button
          type="button"
          aria-label="Refresh provider usage"
          disabled={loading}
          onClick={() => void refresh(true)}
          className="flex size-6 items-center justify-center rounded text-sm text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground disabled:opacity-50"
        >
          {loading ? "…" : "↻"}
        </button>
        <button
          type="button"
          aria-label="Collapse provider usage"
          onClick={dismiss}
          className="flex size-6 items-center justify-center rounded text-base text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
        >
          ×
        </button>
      </header>

      <div className="min-h-0 overflow-y-auto p-3">
        {snapshot === null ? (
          <p className="py-4 text-center text-xs text-muted-foreground">Loading provider quota windows…</p>
        ) : snapshot.status !== "connected" ? (
          <div role="status" className="rounded-lg border border-dashed border-sidebar-border px-3 py-4 text-center">
            <p className="text-xs font-medium">Could not load provider usage</p>
            <p className="mt-1 text-xs text-muted-foreground">{snapshot.message}</p>
            <p className="mt-2 text-2xs text-muted-foreground">Check the URL and management key in Settings → Plugins → CLIProxyAPI Usage.</p>
          </div>
        ) : snapshot.accounts.length === 0 ? (
          <div role="status" className="rounded-lg border border-dashed border-sidebar-border px-3 py-4 text-center">
            <p className="text-xs font-medium">No provider accounts found</p>
            <p className="mt-1 text-xs text-muted-foreground">CLIProxyAPI returned no credentials with quota data.</p>
          </div>
        ) : (
          <div className="space-y-4">
            {providers.map((provider) => {
              const accounts = snapshot.accounts.filter((account) => account.provider === provider);
              return (
                <section key={provider} className="space-y-2">
                  <h2 className="flex items-center gap-2 px-0.5 text-xs font-semibold">
                    <span className="flex size-5 items-center justify-center rounded bg-sidebar-accent text-2xs" aria-hidden="true">
                      {formatProvider(provider).slice(0, 1)}
                    </span>
                    {formatProvider(provider)}
                    <span className="ml-auto text-2xs font-normal text-muted-foreground">{accounts.length} account{accounts.length === 1 ? "" : "s"}</span>
                  </h2>
                  <div className="space-y-2">
                    {accounts.map((account) => <AccountCard key={account.id} account={account} />)}
                  </div>
                </section>
              );
            })}
            <footer className="space-y-1 px-0.5 text-2xs leading-relaxed text-muted-foreground">
              <p>Quota windows are fetched from the configured CLIProxyAPI accounts.</p>
              {snapshot.observedAt ? <p>Updated {new Date(snapshot.observedAt).toLocaleTimeString()}.</p> : null}
            </footer>
          </div>
        )}
      </div>
    </section>
  );
}

export default definePluginApp((app) => {
  // The percentages that stand in for the chart icon (footer.tsx).
  app.slots.experimental_appOverlay({ id: "footer-usage", component: FooterUsage });
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "cliproxy-usage",
    label: "Provider usage",
    icon: "ChartColumn",
    component: UsageDisclosure,
  });
});

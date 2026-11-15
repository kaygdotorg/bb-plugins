/**
 * Usage in the sidebar footer, drawn inside bb's own "Provider usage" button.
 *
 * bb renders footer items itself and only takes an icon, so this overlay finds that button,
 * hides its chart icon and portals pooled percentages into it ([icon] 6%  [icon] 83%).
 * The button stays bb's: clicking the percentages is clicking it, so it opens the same
 * disclosure the icon did. Our content ignores pointer events so the click target is always
 * bb's button (a target inside another React tree could miss bb's handler).
 *
 * Settings (server.ts): footer, footerWindow, footerProviders, footerLabels, warnPercent,
 * criticalPercent. Data: the usage_summary RPC, polled once a minute.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { rpcContract, UsageSummary, UsageWindow } from "./server";

const BUTTON = 'li[data-footer-item] > button[aria-label="Provider usage"]';
const HOST = "data-cliproxy-footer";
const COMPACT = "data-cliproxy-compact";

/** Hides the chart icon and lets the button grow to fit; light mode inks amber darker. */
const STYLE = `
button[${COMPACT}] { width: auto !important; padding-inline: 0.375rem !important; }
button[${COMPACT}] > :not([${HOST}]) { display: none !important; }
[${HOST}] { display: flex; align-items: center; gap: 0.625rem; pointer-events: none; font-size: 0.6875rem; line-height: 1; }
[${HOST}] > span { display: inline-flex; align-items: center; gap: 0.25rem; }
[data-cliproxy-tone="warn"] { color: oklch(0.55 0.15 50); }
.dark [data-cliproxy-tone="warn"] { color: var(--warning, oklch(0.75 0.15 70)); }
`;

const NAMES = { claude: "Claude", codex: "Codex" } as const;
/** bb's own provider logos, drawn as a mask so they take the text colour. */
const LOGOS = {
  claude: "/api/v1/system/providers/claude-code/logo",
  codex: "/api/v1/system/providers/codex/logo",
} as const;

type Provider = UsageSummary["providers"][number];
type Prefs = {
  window: "auto" | "session" | "weekly";
  providers: "both" | "claude" | "codex";
  labels: "icons" | "names";
  warn: number;
  critical: number;
};

function prefsFrom(values: Record<string, string | number | boolean> | undefined): Prefs {
  const v = values ?? {};
  return {
    window: (v.footerWindow as Prefs["window"]) ?? "auto",
    providers: (v.footerProviders as Prefs["providers"]) ?? "both",
    labels: (v.footerLabels as Prefs["labels"]) ?? "icons",
    warn: typeof v.warnPercent === "number" ? v.warnPercent : 75,
    critical: typeof v.criticalPercent === "number" ? v.criticalPercent : 90,
  };
}

function shownWindow(provider: Provider, prefs: Prefs): UsageWindow | null {
  if (prefs.window === "session") return provider.session;
  if (prefs.window === "weekly") return provider.weekly;
  return provider.session ?? provider.weekly;
}

function Entry({ provider, prefs }: { provider: Provider; prefs: Prefs }) {
  const shown = shownWindow(provider, prefs);
  const pct = shown ? Math.round(shown.used * 100) : null;
  const tone = pct === null ? undefined : pct >= prefs.critical ? "critical" : pct >= prefs.warn ? "warn" : undefined;
  const mask = `url(${LOGOS[provider.provider]}) center / contain no-repeat`;
  return (
    <span className={tone === "critical" ? "text-destructive" : tone ? "" : "text-muted-foreground"} data-cliproxy-tone={tone}>
      {prefs.labels === "icons" ? (
        <span aria-hidden="true" className="inline-block size-3 shrink-0" style={{ mask, WebkitMask: mask, backgroundColor: "currentColor" }} />
      ) : (
        <span>{NAMES[provider.provider]}</span>
      )}
      <span className="tabular-nums">{pct === null ? "—" : `${pct}%`}</span>
    </span>
  );
}

/** Words for screen readers, which otherwise only hear the button's "Provider usage". */
function describe(providers: Provider[], prefs: Prefs): string {
  return providers.map((p) => {
    const shown = shownWindow(p, prefs);
    return `${NAMES[p.provider]} ${shown ? `${Math.round(shown.used * 100)}% used` : "no data"}`;
  }).join(", ");
}

export function FooterUsage() {
  const rpc = useRpc<typeof rpcContract>();
  const { values } = useSettings();
  const enabled = values?.footer !== false;
  const prefs = prefsFrom(values);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => rpc.call("usage_summary", { refresh: false })
      .then((value) => { if (alive) setSummary(value); })
      .catch(() => { if (alive) setSummary(null); });
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [rpc, enabled]);

  const providers = (summary?.providers ?? []).filter((p) => prefs.providers === "both" || p.provider === prefs.providers);
  const show = enabled && providers.length > 0;

  // bb re-creates the footer on navigation and when the sidebar collapses: re-attach on a
  // light 1s check instead of observing the whole document.
  useEffect(() => {
    const style = document.createElement("style");
    style.textContent = STYLE;
    document.head.append(style);
    let current: HTMLElement | null = null;
    const attach = () => {
      const button = document.querySelector<HTMLElement>(BUTTON);
      if (!show || !button) {
        current?.closest(BUTTON)?.removeAttribute(COMPACT);
        current?.remove();
        current = null;
        setHost(null);
        return;
      }
      if (current && button.contains(current)) return;
      current = document.createElement("span");
      current.setAttribute(HOST, "");
      button.append(current);
      button.setAttribute(COMPACT, "");
      setHost(current);
    };
    attach();
    const timer = window.setInterval(attach, 1000);
    return () => {
      window.clearInterval(timer);
      current?.closest(BUTTON)?.removeAttribute(COMPACT);
      current?.remove();
      style.remove();
    };
  }, [show]);

  useEffect(() => {
    const button = host?.closest(BUTTON);
    if (button) button.setAttribute("aria-description", describe(providers, prefs));
  });

  if (!host || !show) return null;
  return createPortal(
    <>{providers.map((p) => <Entry key={p.provider} provider={p} prefs={prefs} />)}</>,
    host,
  );
}

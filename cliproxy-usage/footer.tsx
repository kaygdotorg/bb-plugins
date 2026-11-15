/**
 * Usage in the sidebar footer, drawn over bb's own "Provider usage" item.
 *
 * bb renders footer items itself and only takes an icon. It also decides how many items fit
 * by measuring them (floor((row + gap) / (item + gap)) - 1), so bb's item must stay exactly
 * its usual size: when the button grew to fit the percentages, bb moved Settings into "…"
 * and re-rendered the row, which dropped the percentages back to the bare chart icon.
 * So the button keeps its size with its icon hidden, and the percentages ([icon] 6%
 * [icon] 83%) are an overlay that starts there and spans the free space to its right,
 * capped at that space. A click on the overlay presses bb's button (a native .click(), so
 * bb's own handler runs) and opens the same disclosure.
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

/** Keeps bb's button its size (icon hidden); the overlay sits on top. Light mode inks amber darker. */
const STYLE = `
button[${COMPACT}] > * { visibility: hidden; }
[${HOST}] {
  position: absolute; left: 0; top: 0; bottom: 0; z-index: 1;
  width: max-content; max-width: var(--cliproxy-room, 8rem); overflow: hidden;
  display: flex; align-items: center; gap: 0.625rem; padding-inline: 0.5rem;
  border-radius: calc(var(--radius) - 2px); cursor: pointer;
  font-size: 0.6875rem; line-height: 1; white-space: nowrap;
}
[${HOST}]:hover { background: var(--sidebar-accent); }
[${HOST}] > span { display: inline-flex; align-items: center; gap: 0.25rem; }
/* Amber measured for small text (WCAG 4.5:1) on light and dark sidebars. */
[data-cliproxy-tone="warn"] { color: oklch(0.43 0.13 45); }
.dark [data-cliproxy-tone="warn"] { color: oklch(0.8 0.14 70); }
`;

const NAMES = { claude: "Claude", codex: "Codex" } as const;

/** The last summary, so a reload paints the numbers at once instead of ~4s later. */
const CACHE_KEY = "cliproxy-usage:footer-summary";
function cachedSummary(): UsageSummary | null {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as UsageSummary | null; } catch { return null; }
}
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
  const [summary, setSummary] = useState<UsageSummary | null>(cachedSummary);
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () => rpc.call("usage_summary", { refresh: false })
      .then((value) => {
        if (!alive) return;
        setSummary(value);
        try { localStorage.setItem(CACHE_KEY, JSON.stringify(value)); } catch { /* private mode */ }
      })
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
        current?.parentElement?.querySelector("button")?.removeAttribute(COMPACT);
        current?.remove();
        current = null;
        setHost(null);
        return;
      }
      const item = button.parentElement as HTMLElement;
      if (!current || current.parentElement !== item) {
        current?.remove();
        current = document.createElement("span");
        current.setAttribute(HOST, "");
        current.setAttribute("aria-hidden", "true"); // the button carries the words (aria-description)
        current.addEventListener("click", () => item.querySelector<HTMLButtonElement>("button")?.click());
        item.append(current);
        button.setAttribute(COMPACT, "");
        setHost(current);
      }
      // Room = up to the next item to the right in the row (bb's own items, any order).
      const left = item.getBoundingClientRect().left;
      const next = Math.min(...Array.from(item.parentElement?.children ?? [])
        .map((li) => li.getBoundingClientRect().left)
        .filter((x) => x > left + 1), window.innerWidth);
      current.style.setProperty("--cliproxy-room", `${Math.max(item.offsetWidth, next - left - 4)}px`);
    };
    attach();
    // bb draws the footer a moment after load: retry quickly at first, then once a second.
    const early = [100, 300, 700].map((ms) => window.setTimeout(attach, ms));
    const timer = window.setInterval(attach, 1000);
    const resize = new ResizeObserver(attach);
    const row = document.querySelector(BUTTON)?.closest("ul");
    if (row) resize.observe(row);
    return () => {
      window.clearInterval(timer);
      early.forEach(window.clearTimeout);
      resize.disconnect();
      current?.parentElement?.querySelector(BUTTON.split(" > ")[1])?.removeAttribute(COMPACT);
      current?.remove();
      style.remove();
    };
  }, [show]);

  useEffect(() => {
    const button = host?.parentElement?.querySelector("button");
    if (button) button.setAttribute("aria-description", describe(providers, prefs));
  });

  if (!host || !show) return null;
  return createPortal(
    <>{providers.map((p) => <Entry key={p.provider} provider={p} prefs={prefs} />)}</>,
    host,
  );
}

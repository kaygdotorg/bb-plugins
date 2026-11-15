import { isIP } from "node:net";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { summarize } from "./lib/pool";

const bucketSchema = z.object({
  window: z.string(),
  description: z.string(),
  remainingFraction: z.number().min(0).max(1),
  resetTime: z.string(),
});

const groupSchema = z.object({
  name: z.string(),
  buckets: z.array(bucketSchema),
});

const metricSchema = z.object({
  label: z.string(),
  value: z.number(),
  unit: z.string(),
  format: z.string(),
  currency: z.string(),
});

const accountSchema = z.object({
  id: z.string(),
  provider: z.string(),
  email: z.string().nullable(),
  plan: z.string().nullable(),
  observedAt: z.string().nullable(),
  state: z.enum(["available", "observed", "unsupported", "unavailable", "disabled"]),
  message: z.string().nullable(),
  groups: z.array(groupSchema),
  metrics: z.array(metricSchema),
});

const snapshotSchema = z.object({
  status: z.enum(["not-configured", "connected", "error"]),
  message: z.string().nullable(),
  accounts: z.array(accountSchema),
  observedAt: z.string().nullable(),
});

export type UsageSnapshot = z.infer<typeof snapshotSchema>;

/** One quota window pooled across a provider's accounts (lib/pool.ts). */
const windowSchema = z.object({
  used: z.number().min(0).max(1),
  accounts: z.number().int(),
  resetsAt: z.string(),
});
export type UsageWindow = z.infer<typeof windowSchema>;

/** The compact view for the sidebar footer: Claude and Codex, each pooled. */
const summarySchema = z.object({
  status: z.enum(["ok", "unavailable"]),
  message: z.string().nullable(),
  providers: z.array(z.object({
    provider: z.enum(["claude", "codex"]),
    accounts: z.number().int(),
    session: windowSchema.nullable(),
    weekly: windowSchema.nullable(),
  })),
});
export type UsageSummary = z.infer<typeof summarySchema>;

export const rpcContract = defineRpcContract({
  /** Every account with its quota windows (the disclosure; other plugins may read it too). */
  usage_read: {
    input: z.object({ refresh: z.boolean() }),
    output: snapshotSchema,
  },
  /** Pooled per provider, for the footer. */
  usage_summary: {
    input: z.object({ refresh: z.boolean() }),
    output: summarySchema,
  },
});

type JsonObject = Record<string, unknown>;
type SafeAccount = UsageSnapshot["accounts"][number];

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function numericString(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function unixTime(value: unknown): string {
  const seconds = numericString(value);
  return seconds === null || seconds <= 0 ? "" : new Date(seconds * 1000).toISOString();
}

function titleCase(value: string): string {
  return value.replace(/-\d{8}$/, "").replace(/(\d+)-(\d+)(?=-|$)/g, "$1.$2")
    .split(/[-_\s]+/).filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function passiveQuota(provider: string, rawQuota: unknown, rawModelQuotas: unknown): Pick<SafeAccount, "plan" | "groups" | "observedAt"> {
  const topLevel = object(rawQuota) ?? {};
  const signals = new Map(Object.entries(object(topLevel.signals) ?? {})
    .map(([key, value]) => [key.toLowerCase(), value]));
  const groups: SafeAccount["groups"] = [];
  let plan: string | null = null;
  let observedAt = string(topLevel.observed_at ?? topLevel.observedAt) || null;
  const normalizedProvider = provider.toLowerCase();

  if (normalizedProvider === "claude") {
    for (const [suffix, label] of [["5h", "Session"], ["7d", "Weekly"]] as const) {
      const utilization = numericString(signals.get(`anthropic-ratelimit-unified-${suffix}-utilization`));
      if (utilization === null) continue;
      const fraction = utilization > 1 ? utilization / 100 : utilization;
      groups.push({
        name: label,
        buckets: [{
          window: label,
          description: "",
          remainingFraction: Math.max(0, Math.min(1, 1 - fraction)),
          resetTime: unixTime(signals.get(`anthropic-ratelimit-unified-${suffix}-reset`)),
        }],
      });
    }
  } else if (normalizedProvider === "codex") {
    plan = string(signals.get("x-codex-plan-type")) || null;
    const codexLimits = new Map<string, { primary?: number; secondary?: number }>();
    for (const [key, rawValue] of signals.entries()) {
      const directMatch = key.match(/^x-codex-(primary|secondary)-used-percent$/);
      const additionalMatch = key.match(/^x-codex-(?:additional-)?(.+)-(primary|secondary)-used-percent$/);
      const limit = directMatch ? "account" : additionalMatch?.[1];
      const window = directMatch?.[1] ?? additionalMatch?.[2];
      if (!limit || !window) continue;
      const used = numericString(rawValue);
      if (used === null) continue;
      const kind = window as "primary" | "secondary";
      const entry = codexLimits.get(limit) ?? {};
      entry[kind] = used;
      codexLimits.set(limit, entry);
    }
    for (const [limit, windows] of codexLimits) {
      for (const [kind, used] of Object.entries(windows)) {
        if (used === undefined) continue;
        const prefix = limit === "account" ? "x-codex" : `x-codex-${limit}`;
        const prefixAlt = limit === "account" ? prefix : `x-codex-additional-${limit}`;
        const windowMinutes = numericString(signals.get(`${prefix}-${kind}-window-minutes`)
          ?? signals.get(`${prefixAlt}-${kind}-window-minutes`));
        const resetAt = unixTime(signals.get(`${prefix}-${kind}-reset-at`)
          ?? signals.get(`${prefixAlt}-${kind}-reset-at`));
        const resetAfter = numericString(signals.get(`${prefix}-${kind}-reset-after-seconds`)
          ?? signals.get(`${prefixAlt}-${kind}-reset-after-seconds`));
        const resetTime = resetAt || (resetAfter !== null && observedAt
          ? new Date(Date.parse(observedAt) + resetAfter * 1000).toISOString()
          : "");
        const windowLabel = windowMinutes === 300 ? "Session"
          : windowMinutes === 10080 ? "Weekly"
            : windowMinutes !== null && windowMinutes > 0 ? windowMinutes < 60 ? `${windowMinutes}m window`
              : windowMinutes < 1440 ? `${Math.round(windowMinutes / 60)}h window`
                : `${Math.round(windowMinutes / 1440)}d window`
              : titleCase(kind);
        groups.push({
          name: limit === "account" ? windowLabel : `${titleCase(limit)} · ${windowLabel}`,
          buckets: [{
            window: windowLabel,
            description: "",
            remainingFraction: Math.max(0, Math.min(1, 1 - used / 100)),
            resetTime,
          }],
        });
      }
    }
  }

  const modelQuotas = object(rawModelQuotas);
  if (modelQuotas) {
    for (const [model, rawModelQuota] of Object.entries(modelQuotas)) {
      const modelData = object(rawModelQuota) ?? {};
      const modelSignals = new Map(Object.entries(object(modelData.signals) ?? {})
        .map(([key, value]) => [key.toLowerCase(), value]));
      const modelObserved = string(modelData.observed_at ?? modelData.observedAt);
      if (modelObserved && (!observedAt || Date.parse(modelObserved) > Date.parse(observedAt))) {
        observedAt = modelObserved;
      }
      if (normalizedProvider === "claude") {
        for (const [suffix, label] of [["5h", "Session"], ["7d", "Weekly"]] as const) {
          const utilization = numericString(modelSignals.get(`anthropic-ratelimit-unified-${suffix}-utilization`));
          if (utilization === null) continue;
          const fraction = utilization > 1 ? utilization / 100 : utilization;
          groups.push({
            name: `${label} · ${titleCase(model)}`,
            buckets: [{
              window: label,
              description: "",
              remainingFraction: Math.max(0, Math.min(1, 1 - fraction)),
              resetTime: unixTime(modelSignals.get(`anthropic-ratelimit-unified-${suffix}-reset`)),
            }],
          });
        }
      }
    }
  }

  return { plan, groups, observedAt };
}

function privateHttpAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (isIP(host) === 4) {
    const octets = host.split(".").map(Number);
    return octets[0] === 10 || octets[0] === 127
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 168);
  }
  return isIP(host) === 6 && /^(fc|fd|fe80:)/i.test(host);
}

function managementEndpoint(baseUrl: string, path: string): URL {
  const endpoint = new URL(baseUrl.trim());
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("Use an HTTP or HTTPS management URL.");
  }
  if (endpoint.username || endpoint.password) {
    throw new Error("Credentials belong in the management key setting, not the URL.");
  }
  if (endpoint.protocol === "http:" && !privateHttpAddress(endpoint.hostname)) {
    throw new Error("Use HTTPS, or HTTP only with a loopback or private-network address.");
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}${path}`;
  endpoint.search = "";
  endpoint.hash = "";
  return endpoint;
}

function normalizeQuota(value: unknown): Pick<SafeAccount, "plan" | "groups" | "metrics"> {
  const quota = object(value) ?? {};
  const subscription = object(quota.subscription);
  const plan = string(subscription?.plan) || string(subscription?.tierName) || null;
  const groups = Array.isArray(quota.groups) ? quota.groups.flatMap((rawGroup) => {
    const group = object(rawGroup);
    if (!group) return [];
    const buckets = Array.isArray(group.buckets) ? group.buckets.flatMap((rawBucket) => {
      const bucket = object(rawBucket);
      if (!bucket) return [];
      const remaining = finiteNumber(bucket.remainingFraction ?? bucket.remaining_fraction);
      if (remaining === null) return [];
      return [{
        window: string(bucket.window),
        description: string(bucket.description),
        remainingFraction: Math.max(0, Math.min(1, remaining)),
        resetTime: string(bucket.resetTime ?? bucket.reset_time),
      }];
    }) : [];
    return buckets.length > 0 ? [{ name: string(group.displayName ?? group.display_name), buckets }] : [];
  }) : [];
  const metrics = Array.isArray(quota.summary) ? quota.summary.flatMap((rawMetric) => {
    const metric = object(rawMetric);
    if (!metric) return [];
    const value = finiteNumber(metric.value);
    if (value === null) return [];
    return [{
      label: string(metric.label) || string(metric.key),
      value,
      unit: string(metric.unit),
      format: string(metric.format),
      currency: string(metric.currency),
    }];
  }) : [];
  return { plan, groups, metrics };
}

function accountFromCredential(raw: unknown, index: number): {
  base: SafeAccount;
  quotaPluginId: string;
  authIndex: string;
} | null {
  const credential = object(raw);
  if (!credential) return null;
  const authIndex = string(credential.auth_index ?? credential.authIndex);
  const provider = string(credential.provider ?? credential.type) || "unknown";
  if (!authIndex) return null;
  const email = string(credential.email) || null;
  const pluginId = string(credential.quota_plugin_id ?? credential.quotaPluginId);
  const disabled = credential.disabled === true;
  const passive = passiveQuota(provider, credential.quota, credential.model_quotas);
  const hasPassiveQuota = passive.groups.length > 0;
  const base: SafeAccount = {
    id: `${provider}:${authIndex}`,
    provider,
    email,
    plan: passive.plan,
    observedAt: passive.observedAt,
    state: disabled ? "disabled" : pluginId ? "available" : hasPassiveQuota ? "observed" : "unsupported",
    message: disabled ? "This credential is disabled."
      : pluginId ? null : hasPassiveQuota ? "Showing the last quota headers observed by CLIProxyAPI."
        : "CLIProxyAPI has not observed quota data for this account yet.",
    groups: passive.groups,
    metrics: [],
  };
  return { base, quotaPluginId: pluginId, authIndex };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    baseUrl: {
      type: "string",
      label: "CLIProxyAPI management URL",
      description: "The base URL reachable from the BB server, for example https://proxy.example or http://127.0.0.1:8317.",
      default: "",
    },
    managementKey: {
      type: "string",
      label: "Management key",
      description: "Stored as a server-side secret and sent only to the configured CLIProxyAPI instance.",
      secret: true,
    },
    // How the sidebar footer shows usage (read by the app through useSettings()).
    footer: {
      type: "boolean",
      label: "Show usage in the sidebar footer",
      description: "Replaces the chart icon with each provider's usage percentage. Click it for the full breakdown.",
      default: true,
    },
    footerWindow: {
      type: "select",
      label: "Footer window",
      options: ["auto", "session", "weekly"],
      experimental_optionLabels: { auto: "5-hour session, else weekly", session: "5-hour session", weekly: "Weekly" },
      default: "auto",
    },
    footerProviders: {
      type: "select",
      label: "Footer providers",
      options: ["both", "claude", "codex"],
      experimental_optionLabels: { both: "Claude and Codex", claude: "Claude only", codex: "Codex only" },
      default: "both",
    },
    footerLabels: {
      type: "select",
      label: "Footer labels",
      options: ["icons", "names"],
      experimental_optionLabels: { icons: "Provider icons", names: "Provider names" },
      default: "icons",
    },
    warnPercent: {
      type: "number",
      label: "Amber from (% used)",
      default: 75,
    },
    criticalPercent: {
      type: "number",
      label: "Red from (% used)",
      default: 90,
    },
  });

  let config = await settings.get();
  settings.onChange((next) => {
    config = next;
    cache = null;
  });

  let cache: { snapshot: UsageSnapshot; at: number } | null = null;

  async function requestJson(path: string, method: "GET" | "POST" = "GET", body?: unknown): Promise<unknown> {
    const endpoint = managementEndpoint(config.baseUrl, path);
    const response = await fetch(endpoint, {
      method,
      headers: {
        authorization: `Bearer ${(config.managementKey ?? "").trim()}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const message = response.status === 401 || response.status === 403
        ? "CLIProxyAPI rejected the management key."
        : `CLIProxyAPI returned HTTP ${response.status}.`;
      throw new Error(message);
    }
    return response.json();
  }

  async function fetchAccountQuota(account: ReturnType<typeof accountFromCredential>): Promise<SafeAccount> {
    if (!account) {
      return {
        id: `unknown-${Math.random().toString(36).slice(2)}`,
        provider: "unknown",
        email: null,
        plan: null,
        observedAt: null,
        state: "unavailable",
        message: "CLIProxyAPI returned an incomplete credential entry.",
        groups: [],
        metrics: [],
      };
    }
    if (account.base.state !== "available") return account.base;

    try {
      const quota = await requestJson(
        `/v8/management/plugins/${encodeURIComponent(account.quotaPluginId)}/quota`,
        "POST",
        { auth_index: account.authIndex },
      );
      const live = normalizeQuota(quota);
      return {
        ...account.base,
        ...live,
        state: live.groups.length > 0 || live.metrics.length > 0 ? "available" : account.base.state,
        observedAt: new Date().toISOString(),
        message: live.groups.length > 0 || live.metrics.length > 0 ? null : account.base.message,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Quota could not be fetched.";
      return account.base.groups.length > 0
        ? { ...account.base, state: "observed", message: "Live refresh failed; showing quota headers from the last CLIProxyAPI response." }
        : { ...account.base, state: "unavailable", message };
    }
  }

  async function readUsage(refresh: boolean): Promise<UsageSnapshot> {
    if (!config.managementKey?.trim() || !config.baseUrl?.trim()) {
      return {
        status: "not-configured",
        message: "Add the CLIProxyAPI management URL and key in this plugin’s settings.",
        accounts: [],
        observedAt: null,
      };
    }
    if (!refresh && cache !== null && Date.now() - cache.at < 30_000) {
      return cache.snapshot;
    }

    try {
      const credentialResponse = object(await requestJson("/v8/management/credentials"));
      if (!credentialResponse || !Array.isArray(credentialResponse.files)) {
        throw new Error("CLIProxyAPI returned an unexpected credentials response.");
      }

      const credentials = credentialResponse.files
        .map(accountFromCredential)
        .filter((entry) => entry !== null);
      const accounts: SafeAccount[] = [];
      for (let offset = 0; offset < credentials.length; offset += 4) {
        const batch = credentials.slice(offset, offset + 4);
        accounts.push(...await Promise.all(batch.map(fetchAccountQuota)));
      }
      accounts.sort((a, b) => a.provider.localeCompare(b.provider)
        || (a.email ?? "").localeCompare(b.email ?? ""));

      const snapshot: UsageSnapshot = {
        status: "connected",
        message: null,
        accounts,
        observedAt: new Date().toISOString(),
      };
      cache = { snapshot, at: Date.now() };
      return snapshot;
    } catch (error) {
      const message = error instanceof Error && error.name === "TimeoutError"
        ? "CLIProxyAPI did not respond within 12 seconds."
        : error instanceof Error
          ? error.message
          : "Could not reach CLIProxyAPI. Check its URL and network access from the BB server.";
      return { status: "error", message, accounts: [], observedAt: null };
    }
  }

  bb.rpc.register(rpcContract, {
    usage_read: ({ refresh }) => readUsage(refresh),
    usage_summary: async ({ refresh }) => summarize(await readUsage(refresh)),
  });
}

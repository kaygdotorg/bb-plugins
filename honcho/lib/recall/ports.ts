import type { ExperimentalHostClient } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { Conclusion, HonchoClient } from "../honcho-client.js";
import type { RecallHostContract } from "./host-contract.js";
import type { ThreadRef } from "../capture/scope.js";

/**
 * Seams the recall slice needs from code it does not own. Every member is
 * optional: a default built on the slice-1 client is used when absent.
 */
export interface RecallPorts {
  /** Peer card lines. Default: the client's `getPeerCard` if present, else the
   * unscoped `peers/{id}/representation` split into lines (never `chat`). */
  peerCard?(client: HonchoClient, peer: string): Promise<string[] | null>;
  /** Top conclusions for one scope. Default: a semantic conclusions query on
   * the scope name; Honcho v3 has no scope filter on conclusions. */
  scopeConclusions?(client: HonchoClient, peer: string, scope: string, limit: number): Promise<Conclusion[]>;
  /** The scope the capture slice created this thread's session with, when it already knows it (sync). */
  scopeFor?(threadId: string): string | null | undefined;
  /** The plugin's one scope resolver (capture's `scopeFor`). Default: capture's
   * resolver built over this bb, with the same kv cache. */
  resolveScope?(thread: ThreadRef): Promise<string>;
  /** Synchronous settings view. server.ts passes the plugin's one settings handle;
   * without it (unit tests) recall defines `codexUseBbTools` and `hookBudgetMs` itself. */
  settings?: RecallSettings;
  /** The plugin's one host client (built from the full host contract in
   * lib/host-contract.ts). Default: a client over the recall ops alone. */
  host?: ExperimentalHostClient<RecallHostContract> | null;
  /** Capture's deny-list check (`capture.isDenied`). Default: the same facts and lists over this bb. */
  isDenied?(thread: ThreadRef): Promise<boolean>;
  /** bb-secrets values, added to the redaction deny set (lib/secrets.ts). */
  secretValues?(): string[] | Promise<string[]>;
}

export interface RecallSettings {
  codexUseBbTools(): boolean;
  hookBudgetMs(): number;
}

/** The hook's own cap (MAX_BUDGET_MS in hooks/bb-honcho-hook.mjs); a test pins that they agree. */
export const MAX_HOOK_BUDGET_MS = 5_000;
export const DEFAULT_HOOK_BUDGET_MS = 400;

/** A finite value is rounded and capped at the hook's maximum; 0 turns per-turn waiting off.
 * Anything else (unset, negative, NaN) is the default. */
export const clampHookBudget = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.round(value), MAX_HOOK_BUDGET_MS) : DEFAULT_HOOK_BUDGET_MS;

export const RECALL_SETTING_DESCRIPTORS = {
  codexUseBbTools: {
    type: "boolean", label: "Give Codex the bb honcho tools",
    description: "Off keeps codex on its own honcho MCP tools (machines that were not handed over).",
    default: false,
  },
  hookBudgetMs: {
    type: "number", label: "Per-turn recall hook budget (ms)",
    description: `How long the harness prompt hook waits for this turn's memory: 0 to ${MAX_HOOK_BUDGET_MS} ms (0 never waits).`,
    experimental_schema: z.number().int().min(0).max(MAX_HOOK_BUDGET_MS),
    default: DEFAULT_HOOK_BUDGET_MS,
  },
} as const;

type PeerCardClient = HonchoClient & { getPeerCard?(peer: string): Promise<string[] | null | { peer_card?: string[] | null }> };

export async function defaultPeerCard(client: HonchoClient, peer: string): Promise<string[] | null> {
  const withCard = client as PeerCardClient;
  if (typeof withCard.getPeerCard === "function") {
    const card = await withCard.getPeerCard(peer);
    return Array.isArray(card) ? card : card?.peer_card ?? null;
  }
  const { representation } = await client.peerRepresentation(peer, { max_conclusions: 20 });
  const lines = (representation ?? "").split("\n").map(l => l.replace(/^\s*[-*]\s+/, "").trim()).filter(Boolean);
  return lines.length ? lines : null;
}

export async function defaultScopeConclusions(client: HonchoClient, peer: string, scope: string, limit: number): Promise<Conclusion[]> {
  return client.queryConclusions({ query: scope, top_k: limit, filters: { observer: peer, observed: peer } });
}

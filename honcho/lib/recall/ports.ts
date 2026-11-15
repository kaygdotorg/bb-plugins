import type { Conclusion, HonchoClient } from "../honcho-client.js";

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
  /** The scope the capture slice created this thread's session with, when it knows it. */
  scopeFor?(threadId: string): string | null | undefined;
  /** Synchronous settings view. Default: recall defines `codexUseBbTools` and `hookBudgetMs` itself. */
  settings?: RecallSettings;
}

export interface RecallSettings {
  codexUseBbTools(): boolean;
  hookBudgetMs(): number;
}

export const RECALL_SETTING_DESCRIPTORS = {
  codexUseBbTools: {
    type: "boolean", label: "Give Codex the bb honcho tools",
    description: "Off keeps codex on its own honcho MCP tools (machines that were not handed over).",
    default: false,
  },
  hookBudgetMs: {
    type: "number", label: "Per-turn recall hook budget (ms)",
    description: "How long the harness prompt hook waits for this turn's memory.",
    default: 400,
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

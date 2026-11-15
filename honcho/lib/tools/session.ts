import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { HonchoClient, PeerConfig } from "../honcho-client.js";
import { sessionMetadata } from "../mapping.js";
import { resolvePeer } from "../rpc-server.js";
import type { RecallShared } from "../recall/shared.js";

export interface ToolThread {
  id: string; projectId: string; environmentId: string | null; providerId: string;
  parentThreadId?: string | null; sourceThreadId?: string | null;
  originKind?: string | null; originPluginId?: string | null;
}

/**
 * Get-or-create the calling thread's Honcho session the way capture's
 * `ensureSession` (lib/capture/service.ts) creates it: same id, scope (capture's
 * resolver), metadata and peers (the user studied, the ai peer not). The model
 * is not known here; capture's own later call carries it.
 */
export async function ensureThreadSession(bb: BbPluginApi, shared: RecallShared, client: HonchoClient, peer: string, thread: ToolThread): Promise<void> {
  const ref = { id: thread.id, projectId: thread.projectId, environmentId: thread.environmentId ?? null };
  const [scope, aiPeer, env] = await Promise.all([
    shared.scopes.forThread(ref),
    resolvePeer(bb.storage.kv, thread.providerId),
    thread.environmentId ? bb.sdk.environments.get({ environmentId: thread.environmentId }).catch(() => null) : Promise.resolve(null),
  ]);
  const peers: Record<string, PeerConfig> = {
    [aiPeer]: { observe_me: false, observe_others: false },
    [peer]: { observe_me: true, observe_others: false },
  };
  const sideChat = thread.originKind === "fork" && thread.originPluginId === "side-chat";
  const metadata = sessionMetadata({
    provider: thread.providerId, host: env?.hostId ?? null, environment: env?.id ?? null, project: thread.projectId,
    parentThread: thread.parentThreadId ?? thread.sourceThreadId ?? null,
    origin: sideChat ? "side-chat" : thread.originKind ?? (thread.originPluginId ? `plugin:${thread.originPluginId}` : null),
    ...(sideChat ? { sideChat: true } : {}),
  });
  await client.getOrCreateSession(thread.id, { metadata, peers, scopes: [scope] });
}

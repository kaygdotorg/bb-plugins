import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { Deps, ConclusionView } from "../contract.js";
import { HonchoError, type Conclusion, type HonchoClient } from "../honcho-client.js";
import { scopeSlug } from "../mapping.js";
import { createScopeResolver, type ThreadRef } from "../capture/scope.js";
import { recallHostContract, type RecallHostContract } from "./host-contract.js";
import { RecallStore, type ConclusionMark } from "./store.js";
import type { RecallPorts } from "./ports.js";

export type KeyLevel = "workspace-or-admin" | "restricted" | "unknown";
const KEY_LEVEL_TTL_MS = 10 * 60_000;

export interface ScopeInput {
  threadId: string;
  parentThreadId?: string | null;
  sideChat?: boolean;
  /** Ids the shared resolver looks the environment and project up by. */
  projectId: string;
  environmentId?: string | null;
  path?: string | null;
  isGitRepo?: boolean | null;
  projectName: string;
}

/** The one scope resolver: capture's `scopeFor` (lib/capture/scope.ts). */
export type ScopeLookup = (thread: ThreadRef) => Promise<string>;

/**
 * Recall's view of the session scope. It never computes a scope of its own:
 * the async path asks the plugin's one resolver (capture's `scopeFor`, which
 * reads the git common dir through the thread's host and keeps the result),
 * so recall searches exactly the scope capture created the session in. The
 * synchronous path (configure) serves what is already known; until then it
 * falls back to the project name and the caller schedules `resolve`.
 */
export class ScopeResolver {
  private readonly byThread = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();
  constructor(private readonly ports: RecallPorts, private readonly lookup: ScopeLookup) {}

  /** The thread whose memory context applies: side chats use their parent's. */
  static contextThread(input: Pick<ScopeInput, "threadId" | "parentThreadId" | "sideChat">): string {
    return input.sideChat && input.parentThreadId ? input.parentThreadId : input.threadId;
  }
  known(threadId: string): string | null {
    return this.byThread.get(threadId) ?? this.ports.scopeFor?.(threadId) ?? null;
  }
  /** Synchronous; never touches the network. `provisional` means the resolver has not answered yet. */
  sync(input: ScopeInput): { scope: string; provisional: boolean } {
    const key = ScopeResolver.contextThread(input);
    const known = this.known(key);
    if (known) { this.remember(input.threadId, known); return { scope: known, provisional: false }; }
    // No environment yet (a queued thread): the scope is not decided, so nothing is kept.
    if (!input.environmentId) return { scope: scopeSlug(input.projectName), provisional: false };
    // Outside git the resolver's answer is the project name too, so it is final.
    if (input.isGitRepo === false || !input.path) return { scope: this.settle(input, key, scopeSlug(input.projectName)), provisional: false };
    return { scope: scopeSlug(input.projectName), provisional: true };
  }
  async resolve(input: ScopeInput): Promise<string> {
    const key = ScopeResolver.contextThread(input);
    const known = this.known(key);
    if (known) { this.remember(input.threadId, known); return known; }
    if (!input.environmentId) return scopeSlug(input.projectName);
    let run = this.pending.get(key);
    if (!run) {
      run = this.lookup({ id: key, projectId: input.projectId, environmentId: input.environmentId ?? null })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, run);
    }
    try { return this.settle(input, key, await run); }
    catch { return this.sync(input).scope; }
  }
  remember(threadId: string, scope: string): void { this.byThread.set(threadId, scope); }
  private settle(input: ScopeInput, key: string, scope: string): string {
    this.byThread.set(key, scope);
    this.byThread.set(input.threadId, scope);
    return scope;
  }
}

export class KeyLevelProbe {
  private value: { level: KeyLevel; at: number } | null = null;
  constructor(private readonly deps: Pick<Deps, "client">) {}
  current(): KeyLevel { return this.value?.level ?? "unknown"; }
  /** Restricted once a 403 is seen on a scoped/workspace call, even before the probe ran. */
  noteForbidden(): void { this.value = { level: "restricted", at: Date.now() }; }
  async get(): Promise<KeyLevel> {
    if (this.value && this.value.level !== "unknown" && Date.now() - this.value.at < KEY_LEVEL_TTL_MS) return this.value.level;
    try {
      const client = await this.deps.client();
      this.value = { level: await client.probeKeyLevel(), at: Date.now() };
    } catch { this.value = { level: "unknown", at: Date.now() }; }
    return this.value.level;
  }
}

/** Explicit conclusions without a local mark come from an agent (claude-honcho's
 * tools); bb's own imports are marked confirmed when created. */
export function toView(conclusion: Conclusion, mark: ConclusionMark | null | undefined): ConclusionView {
  const confirmed = mark?.confirmed ?? false;
  const agentWritten = mark ? mark.agentWritten : conclusion.level === "explicit";
  return { ...conclusion, agentWritten, confirmed };
}

export function describeError(error: unknown): string {
  if (error instanceof HonchoError) {
    switch (error.kind) {
      case "offline": return "Honcho is offline (the server could not be reached). Memory is unavailable right now; continue without it.";
      case "auth": return error.status === 403
        ? "The Honcho key is not allowed to do this (HTTP 403)."
        : "Honcho rejected the API key (auth failure). Fix the key in ~/.honcho/config.json or the plugin's connection settings.";
      case "rate-limited": return "Honcho is rate-limiting requests; try again shortly.";
      case "validation": return "Honcho rejected the request as invalid.";
      default: return `Honcho request failed (${error.kind}${error.status ? ` ${error.status}` : ""}).`;
    }
  }
  return "Honcho request failed.";
}

export interface RecallShared {
  store: RecallStore;
  keyLevel: KeyLevelProbe;
  scopes: ScopeResolver;
  host: ExperimentalHostClient<RecallHostContract> | null;
  ports: RecallPorts;
  peerName: string | null;
  client(): Promise<{ client: HonchoClient; peer: string }>;
}

const shared = new WeakMap<BbPluginApi, RecallShared>();

/** One store / probe / resolver per plugin load, shared by recall and tools. */
export function recallShared(bb: BbPluginApi, deps: Deps, ports: RecallPorts = {}): RecallShared {
  const existing = shared.get(bb);
  if (existing) { Object.assign(existing.ports, ports); return existing; }
  let host: ExperimentalHostClient<RecallHostContract> | null = ports.host ?? null;
  if (ports.host === undefined) { try { host = bb.hosts.experimental_client({ contract: recallHostContract }); } catch { host = null; } }
  const portsRef: RecallPorts = { ...ports };
  let fallback: ((thread: ThreadRef) => Promise<string>) | undefined;
  const state: RecallShared = {
    store: new RecallStore(bb.storage.database()),
    keyLevel: new KeyLevelProbe(deps),
    // Without a resolver from server.ts (unit tests), capture's resolver over this bb.
    scopes: new ScopeResolver(portsRef, thread => (portsRef.resolveScope ?? (fallback ??= createScopeResolver(bb)))(thread)),
    host, ports: portsRef, peerName: null,
    async client() {
      const [client, config] = await Promise.all([deps.client(), deps.config()]);
      state.peerName = config.config.peerName;
      return { client, peer: config.config.peerName };
    },
  };
  shared.set(bb, state);
  return state;
}

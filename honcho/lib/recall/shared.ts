import type { BbPluginApi, ExperimentalHostClient } from "@get-bb/plugin-sdk";
import type { Deps, ConclusionView } from "../contract.js";
import { HonchoError, type Conclusion, type HonchoClient } from "../honcho-client.js";
import { scopeSlug, sessionScope } from "../mapping.js";
import { recallHostContract, type RecallHostContract } from "./host-contract.js";
import { RecallStore, type ConclusionMark } from "./store.js";
import type { RecallPorts } from "./ports.js";

export type KeyLevel = "workspace-or-admin" | "restricted" | "unknown";
const KEY_LEVEL_TTL_MS = 10 * 60_000;

export interface ScopeInput {
  threadId: string;
  parentThreadId?: string | null;
  sideChat?: boolean;
  hostId?: string | null;
  path?: string | null;
  isGitRepo?: boolean | null;
  projectName: string;
}

/**
 * Scope resolution, computed exactly like the capture slice's session scope
 * (lib/mapping.ts `sessionScope`). The git common dir comes from the thread's
 * own host (recall.gitCommonDir); until it is known, the synchronous path falls
 * back to the project name and the caller schedules `resolve`.
 */
export class ScopeResolver {
  private readonly byThread = new Map<string, string>();
  private readonly commonDirs = new Map<string, string | null>();
  private readonly pending = new Map<string, Promise<void>>();
  constructor(private readonly ports: RecallPorts, private readonly host: ExperimentalHostClient<RecallHostContract> | null) {}

  /** The thread whose memory context applies: side chats use their parent's. */
  static contextThread(input: Pick<ScopeInput, "threadId" | "parentThreadId" | "sideChat">): string {
    return input.sideChat && input.parentThreadId ? input.parentThreadId : input.threadId;
  }
  known(threadId: string): string | null {
    return this.ports.scopeFor?.(threadId) ?? this.byThread.get(threadId) ?? null;
  }
  /** Synchronous; never touches the network. `provisional` means the git common dir was not known yet. */
  sync(input: ScopeInput): { scope: string; provisional: boolean } {
    const key = ScopeResolver.contextThread(input);
    const known = this.known(key);
    if (known) { this.remember(input.threadId, known); return { scope: known, provisional: false }; }
    const dirKey = input.hostId && input.path ? `${input.hostId}\0${input.path}` : null;
    if (input.isGitRepo === false || !input.path) return { scope: this.settle(input, key, null), provisional: false };
    if (dirKey && this.commonDirs.has(dirKey)) return { scope: this.settle(input, key, this.commonDirs.get(dirKey)!), provisional: false };
    return { scope: scopeSlug(input.projectName), provisional: true };
  }
  async resolve(input: ScopeInput): Promise<string> {
    const first = this.sync(input);
    if (!first.provisional || !this.host || !input.hostId || !input.path) return first.scope;
    const dirKey = `${input.hostId}\0${input.path}`;
    let run = this.pending.get(dirKey);
    if (!run) {
      run = this.host.call("recall.gitCommonDir", { cwd: input.path }, { hostId: input.hostId, signal: AbortSignal.timeout(8_000) })
        .then(r => { this.commonDirs.set(dirKey, r.commonDir); }, () => undefined)
        .finally(() => this.pending.delete(dirKey));
      this.pending.set(dirKey, run);
    }
    await run;
    return this.sync(input).scope;
  }
  remember(threadId: string, scope: string): void { this.byThread.set(threadId, scope); }
  private settle(input: ScopeInput, key: string, commonDir: string | null): string {
    const scope = sessionScope({ project: input.projectName, cwd: input.path ?? undefined, commonDir });
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
  const state: RecallShared = {
    store: new RecallStore(bb.storage.database()),
    keyLevel: new KeyLevelProbe(deps),
    scopes: new ScopeResolver(portsRef, host),
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

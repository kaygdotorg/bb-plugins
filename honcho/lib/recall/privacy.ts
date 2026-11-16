import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Deps, PrivacySettings } from "../contract.js";
import { threadFacts, type ThreadRef } from "../capture/scope.js";
import { redact, type RedactionResult } from "../redact.js";
import { readPrivacy } from "../rpc-server.js";
import type { RecallPorts } from "./ports.js";

/** How long a deny answer is served without asking again (still refreshed in the background). */
export const DENY_TTL_MS = 5 * 60_000;

export interface GateThread extends ThreadRef {
  /** The thread whose memory is used (a side chat's parent), when it differs. */
  contextThreadId?: string | null;
}

function compile(patterns: readonly string[]): RegExp[] {
  return patterns.flatMap(p => { try { return [new RegExp(p)]; } catch { return []; } });
}

/**
 * Pause, deny and redaction for recall and the tools. Pauses come from the
 * outbox (synchronous); the deny list from capture's `isDenied` (async), kept
 * per thread so session build, which is synchronous, can read it.
 */
export class PrivacyGate {
  private readonly denied = new Map<string, { value: boolean; at: number }>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private privacy: PrivacySettings | null = null;
  private fallback: ((thread: ThreadRef) => Promise<boolean>) | null = null;

  constructor(private readonly bb: BbPluginApi, private readonly deps: Pick<Deps, "config" | "outbox">, private readonly ports: RecallPorts,
    private readonly now: () => number = Date.now) {
    void this.loadPrivacy().catch(() => undefined);
  }

  private async loadPrivacy(): Promise<PrivacySettings> {
    const privacy = await readPrivacy(this.bb.storage.kv);
    this.privacy = privacy;
    return privacy;
  }

  /** Thread, context thread or project paused right now. */
  paused(thread: GateThread): boolean {
    const outbox = this.deps.outbox;
    const scope = this.ports.scopeFor?.(thread.contextThreadId || thread.id);
    return (!!scope && outbox.groupPaused(scope)) || outbox.isPausedNow("thread", thread.id)
      || (!!thread.contextThreadId && thread.contextThreadId !== thread.id && outbox.isPausedNow("thread", thread.contextThreadId))
      || outbox.isPausedNow("project", thread.projectId);
  }

  private isDenied(thread: ThreadRef): Promise<boolean> {
    if (this.ports.isDenied) return this.ports.isDenied(thread);
    // Without capture's check (unit tests): the same facts and deny lists capture uses.
    if (!this.fallback) {
      const facts = threadFacts(this.bb as never);
      this.fallback = async t => (await facts.denied(t, await this.loadPrivacy())) !== null;
    }
    return this.fallback(thread);
  }

  /** Asks capture's deny check; an error counts as denied and is not kept. */
  checkDenied(thread: ThreadRef): Promise<boolean> {
    let run = this.pending.get(thread.id);
    if (!run) {
      void this.loadPrivacy().catch(() => undefined);
      run = this.isDenied(thread).then(
        value => { this.denied.set(thread.id, { value, at: this.now() }); return value; },
        () => true,
      ).finally(() => this.pending.delete(thread.id));
      this.pending.set(thread.id, run);
    }
    return run;
  }

  /** Paused or deny-listed. */
  async blocked(thread: GateThread): Promise<boolean> {
    if (this.paused(thread)) return true;
    if (await this.groupPaused(thread)) return true;
    return this.checkDenied(thread);
  }

  private async groupPaused(thread: GateThread): Promise<boolean> {
    if (!this.deps.outbox.anyGroupPaused()) return false;
    if (!this.ports.resolveScope) return true;
    try {
      const target = thread.contextThreadId && thread.contextThreadId !== thread.id
        ? await this.bb.sdk.threads.get({ threadId: thread.contextThreadId }) : thread;
      return this.deps.outbox.groupPaused(await this.ports.resolveScope(target));
    } catch { return true; }
  }

  /**
   * Synchronous view for session build: true/false, or null when the deny
   * answer is not known yet (the caller fails closed; a check is started).
   */
  blockedNow(thread: GateThread): boolean | null {
    if (this.paused(thread)) return true;
    if (this.deps.outbox.anyGroupPaused() && !this.ports.scopeFor?.(thread.contextThreadId || thread.id)) {
      void this.groupPaused(thread);
      return null;
    }
    const known = this.denied.get(thread.id);
    if (!known || this.now() - known.at > DENY_TTL_MS) void this.checkDenied(thread);
    if (known) return known.value;
    // Capture's check denies nothing while both deny lists are empty (lib/capture/scope.ts `denied`).
    if (this.privacy && !this.privacy.denyRemotes.length && !this.privacy.denyPaths.length) return false;
    return null;
  }

  /** The shared redaction: config credentials, bb-secrets values, the user's patterns. */
  async redactor(): Promise<(text: string) => RedactionResult> {
    const [{ keys }, privacy, secrets] = await Promise.all([
      this.deps.config(), this.loadPrivacy(), Promise.resolve(this.ports.secretValues?.() ?? []),
    ]);
    const options = { deny: [...keys, ...secrets], patterns: compile(privacy.patterns) };
    return text => redact(text, options);
  }
}

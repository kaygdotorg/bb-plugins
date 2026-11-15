import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { Deps } from "../contract";
import { HonchoError, type HonchoClient, type Message, type MessageDraft, type PeerConfig } from "../honcho-client";
import type { RedactionOptions } from "../redact";
import type { Sleep } from "./rate";

export type ThreadSummary = Awaited<ReturnType<BbPluginApi["sdk"]["threads"]["list"]>>[number];

/** Everything backfill needs from Honcho, behind one seam so the CORE slice's client
 * changes (metadata message listing, session create with peers and scopes, created_at)
 * can't ripple through the service. */
export interface HonchoPort {
  /** True if the session holds at least one message. A missing session is false. */
  sessionHasMessages(session: string): Promise<boolean>;
  /** Every message of a session, optionally only those matching message metadata. */
  listMessages(session: string, metadata?: Record<string, string | number | boolean>): Promise<Message[]>;
  ensureSession(session: string, options: { metadata?: Record<string, string | boolean>; peers: Record<string, PeerConfig>; scopes: string[] }): Promise<void>;
  createMessages(session: string, messages: readonly MessageDraft[]): Promise<void>;
}

const PAGE = 100;
export function honchoPort(client: HonchoClient): HonchoPort {
  const orEmpty = async <T>(value: Promise<T>, empty: T): Promise<T> => {
    try { return await value; } catch (error) {
      if (error instanceof HonchoError && error.status === 404) return empty;
      throw error;
    }
  };
  return {
    async sessionHasMessages(session) {
      const page = await orEmpty(client.listMessages(session, {}, { page: 1, size: 1 }), { items: [] as Message[] });
      return page.items.length > 0;
    },
    async listMessages(session, metadata = {}) {
      const all: Message[] = [];
      for (let page = 1; ; page++) {
        const result = await orEmpty(client.listMessages(session, metadata, { page, size: PAGE }), { items: [] as Message[] });
        all.push(...result.items);
        if (result.items.length < PAGE || (result.total != null && all.length >= result.total)) return all;
      }
    },
    async ensureSession(session, options) { await client.getOrCreateSession(session, options); },
    async createMessages(session, messages) { await client.createMessages(session, messages); },
  };
}

/** Collaborators beyond the shared `Deps`. All optional: the server wiring injects the
 * slice-owned ones (privacy, scope, setting); tests inject the clock. */
export interface BackfillDeps extends Deps {
  /** `backfillMessagesPerMinute` setting; default 300. */
  messagesPerMinute?(): Promise<number> | number;
  /** Extra redaction (user patterns). Config keys are always added. */
  redaction?(): Promise<RedactionOptions> | RedactionOptions;
  /** True when the privacy deny list covers the thread (remote glob / path glob). */
  isDenied?(thread: ThreadSummary): Promise<boolean> | boolean;
  /** Scope for the thread's session; must match capture's. Default: the project id. */
  scopeFor?(thread: ThreadSummary): Promise<string> | string;
  /** Replaceable Honcho seam; default wraps `deps.client()`. */
  honcho?(): Promise<HonchoPort>;
  now?(): number;
  sleep?: Sleep;
}

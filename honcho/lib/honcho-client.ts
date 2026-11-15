export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Metadata = Record<string, Json>;
export interface PeerConfig { observe_me?: boolean; observe_others?: boolean }
export interface MessageDraft {
  content: string; peer_id: string; metadata?: Metadata;
  configuration?: { reasoning?: { enabled: boolean } }; created_at?: string;
}
export interface Resource { id: string; metadata?: Metadata; configuration?: Metadata; created_at: string }
export interface Workspace extends Resource { uid: string }
export interface Peer extends Resource { workspace_id: string }
export interface Session extends Resource { uid: string; workspace_id: string; is_active: boolean; scopes?: string[] | null }
export interface Message extends Resource { content: string; peer_id: string; session_id: string; workspace_id: string; token_count: number }
export interface ConclusionDraft { content: string; observer_id: string; observed_id: string; session_id?: string }
export interface Conclusion extends ConclusionDraft { id: string; created_at: string; level?: "explicit" | "deductive" | "inductive" | "contradiction"; source_ids?: string[]; source_message_ids?: string[] | null; times_derived?: number }
export interface Page<T> { items: T[]; total?: number | null; current_page?: string | null; previous_page?: string | null; current_page_backwards?: string | null; page?: number; size?: number; pages?: number; next_page?: string | null }
export interface Pagination { page?: number; size?: number; cursor?: string; reverse?: boolean }
export type ReasoningLevel = "minimal" | "low" | "medium" | "high" | "max";
export interface ChatOptions { query: string; scope?: string | string[]; session_id?: string; reasoning_level?: ReasoningLevel }
export interface PeerChatOptions extends ChatOptions { target?: string; filters?: Metadata }
export interface ChatResult { content: string | null }
export interface SearchOptions { query: string; filters?: Metadata; limit?: number }
/** Metadata filter for a bb_seq range, e.g. seqRange(5, 9) -> { bb_seq: { gte: 5, lte: 9 } }. Merge into listMessages metadata. */
export function seqRange(from?: number, to?: number): Metadata {
  return { bb_seq: { ...(from === undefined ? {} : { gte: from }), ...(to === undefined ? {} : { lte: to }) } };
}
/** What list and query accept for conclusions. observer/observed become observer_id/observed_id on the wire,
 * as the official SDK sends them. Other keys (level, source_ids: { contains }) pass through. */
export type ConclusionFilters = Metadata & { session_id?: string; observer?: string; observed?: string };
function conclusionFilters(filters: ConclusionFilters = {}): Metadata {
  const { observer, observed, ...rest } = filters;
  return { ...(observer === undefined ? {} : { observer_id: observer }), ...(observed === undefined ? {} : { observed_id: observed }), ...rest };
}
export type HonchoErrorKind = "auth" | "offline" | "rate-limited" | "validation" | "server" | "http";
export class HonchoError extends Error {
  constructor(public readonly kind: HonchoErrorKind, public readonly status?: number, public readonly retryAfter?: string) {
    super(`Honcho ${kind}${status === undefined ? "" : ` (HTTP ${status})`}.`);
    this.name = "HonchoError";
  }
}
export interface ClientOptions { baseUrl: string; apiKey?: string; workspace: string; fetch?: typeof fetch }
export type KeyCapability = "workspace-or-admin" | "restricted";
const id = encodeURIComponent;

/** Narrow v3 REST transport. No SDK, no global state, no response bodies or
 * request URLs in errors (servers and fetch implementations can echo keys). */
export class HonchoClient {
  private readonly base: string;
  private readonly transport: typeof fetch;
  constructor(private readonly options: ClientOptions) {
    try {
      const url = new URL(options.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      this.base = url.href.replace(/\/$/, "").replace(/\/v3$/, "");
    } catch { throw new HonchoError("validation"); }
    this.transport = options.fetch ?? fetch;
  }
  private workspacePath(path = ""): string { return `/workspaces/${id(this.options.workspace)}${path}`; }
  private async request<T>(path: string, body?: unknown, method = "POST", pagination: Pagination = {}, retry = true): Promise<T> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(pagination)) if (value !== undefined) params.set(key, String(value));
    const url = `${this.base}/v3${path}${params.size ? `?${params}` : ""}`;
    const attempts = retry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.transport(url, {
          method, headers: {
            ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(8_000), redirect: "error",
        });
        if (!response.ok) {
          const status = response.status;
          const retryAfter = response.headers.get("retry-after") ?? undefined;
          // Do not consume or retain server error text.
          await response.body?.cancel();
          if (status >= 500 && attempt < attempts - 1) continue;
          throw new HonchoError(status === 401 || status === 403 ? "auth"
            : status === 429 ? "rate-limited" : status === 400 || status === 422 ? "validation"
              : status >= 500 ? "server" : "http", status, /^\d+$/.test(retryAfter ?? "") ? retryAfter : undefined);
        }
        const text = await response.text();
        if (!text) return undefined as T;
        try { return JSON.parse(text) as T; }
        catch { throw new HonchoError("validation", response.status); }
      } catch (error) {
        if (error instanceof HonchoError) throw error;
        if (attempt >= attempts - 1) throw new HonchoError("offline");
      }
    }
    throw new HonchoError("offline");
  }
  getOrCreateWorkspace(metadata?: Metadata, configuration?: Metadata): Promise<Workspace> {
    return this.request("/workspaces", { id: this.options.workspace, metadata, configuration });
  }
  getOrCreatePeer(peer: string, metadata?: Metadata, configuration?: Metadata & { observe_me?: never; observe_others?: never }): Promise<Peer> {
    if (configuration && ("observe_me" in configuration || "observe_others" in configuration)) throw new HonchoError("validation");
    return this.request(this.workspacePath("/peers"), { id: peer, metadata, configuration });
  }
  /** Peers and scopes belong in the create call, so the session joins its scope before any message. */
  getOrCreateSession(session: string, options: { metadata?: Metadata; configuration?: Metadata; peers?: Record<string, PeerConfig>; scopes?: string[] } = {}): Promise<Session> {
    if (!/^[a-zA-Z0-9_-]{1,512}$/.test(session) || options.scopes?.some(scope => !/^[a-zA-Z0-9_-]+$/.test(scope)) || (options.scopes?.length ?? 0) > 100) throw new HonchoError("validation");
    return this.request(this.workspacePath("/sessions"), { id: session, ...options });
  }
  addPeers(session: string, peers: Record<string, PeerConfig>): Promise<Session> {
    return this.request(this.workspacePath(`/sessions/${id(session)}/peers`), peers);
  }
  createMessages(session: string, messages: readonly MessageDraft[]): Promise<Message[]> {
    if (messages.length < 1 || messages.length > 100 || messages.some(m => m.content.length > 25_000)) throw new HonchoError("validation");
    // Never retried here: a 5xx after commit would duplicate messages, and Honcho cannot delete them.
    return this.request(this.workspacePath(`/sessions/${id(session)}/messages`), { messages }, "POST", {}, false);
  }
  /** `metadata` is matched against message metadata; values may carry operators, e.g. seqRange(5, 9). */
  listMessages(session: string, metadata: Metadata = {}, pagination?: Pagination): Promise<Page<Message>> {
    return this.request(this.workspacePath(`/sessions/${id(session)}/messages/list`), { filters: { metadata } }, "POST", pagination);
  }
  /** Follows v3 pages (page/size until page >= pages) up to `max` items (default 1000). */
  async listAllMessages(session: string, metadata: Metadata = {}, max = 1000): Promise<Message[]> {
    const all: Message[] = [];
    const size = Math.min(100, Math.max(1, max));
    for (let page = 1; all.length < max; page++) {
      const result = await this.listMessages(session, metadata, { page, size });
      all.push(...result.items);
      if (result.items.length === 0 || page >= (result.pages ?? page)) break;
    }
    return all.slice(0, max);
  }
  updateMessageMetadata(session: string, message: string, metadata: Metadata): Promise<Message> {
    // Honcho replaces metadata; callers merge the existing fields before marking superseded.
    return this.request(this.workspacePath(`/sessions/${id(session)}/messages/${id(message)}`), { metadata }, "PUT");
  }
  peerRepresentation(peer: string, options: Omit<PeerChatOptions, "query" | "reasoning_level"> & { search_query?: string; search_top_k?: number; search_max_distance?: number; include_most_frequent?: boolean; max_conclusions?: number } = {}): Promise<{ representation: string }> {
    if (options.scope !== undefined && (options.session_id !== undefined || options.filters !== undefined)) throw new HonchoError("validation");
    return this.request(this.workspacePath(`/peers/${id(peer)}/representation`), options);
  }
  searchWorkspace(options: SearchOptions & { scope?: string }): Promise<Message[]> {
    return this.request(this.workspacePath("/search"), options);
  }
  searchSession(session: string, options: SearchOptions): Promise<Message[]> {
    return this.request(this.workspacePath(`/sessions/${id(session)}/search`), options);
  }
  searchPeer(peer: string, options: SearchOptions): Promise<Message[]> {
    return this.request(this.workspacePath(`/peers/${id(peer)}/search`), options);
  }
  peerChat(peer: string, options: PeerChatOptions): Promise<ChatResult> {
    if (options.scope !== undefined && (options.session_id !== undefined || options.filters !== undefined)) throw new HonchoError("validation");
    return this.request(this.workspacePath(`/peers/${id(peer)}/chat`), { reasoning_level: "low", ...options, stream: false });
  }
  workspaceChat(options: ChatOptions): Promise<ChatResult> {
    if (options.scope !== undefined && options.session_id !== undefined) throw new HonchoError("validation");
    return this.request(this.workspacePath("/chat"), { reasoning_level: "low", ...options, stream: false });
  }
  listConclusions(filters: ConclusionFilters = {}, pagination?: Pagination): Promise<Page<Conclusion>> {
    return this.request(this.workspacePath("/conclusions/list"), { filters: conclusionFilters(filters) }, "POST", pagination);
  }
  /** Semantic search. The server requires the observer/observed pair. */
  queryConclusions(options: { query: string; top_k?: number; distance?: number; filters: ConclusionFilters & { observer: string; observed: string } }): Promise<Conclusion[]> {
    if (!options.filters?.observer || !options.filters?.observed || (options.top_k !== undefined && (options.top_k < 1 || options.top_k > 100))) throw new HonchoError("validation");
    return this.request(this.workspacePath("/conclusions/query"), { ...options, filters: conclusionFilters(options.filters) });
  }
  createConclusions(conclusions: readonly ConclusionDraft[]): Promise<Conclusion[]> {
    if (conclusions.length < 1 || conclusions.length > 100) throw new HonchoError("validation");
    // Never retried here: the caller's recovery path owns it.
    return this.request(this.workspacePath("/conclusions"), { conclusions }, "POST", {}, false);
  }
  deleteConclusion(conclusion: string): Promise<void> {
    return this.request(this.workspacePath(`/conclusions/${id(conclusion)}`), undefined, "DELETE");
  }
  async addSessionToScope(scope: string, session: string): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(scope)) throw new HonchoError("validation");
    await this.request(this.workspacePath("/scopes"), { id: scope });
    await this.request(this.workspacePath(`/scopes/${id(scope)}/sessions`), { session_ids: [session] });
  }
  deleteSession(session: string): Promise<void> {
    return this.request(this.workspacePath(`/sessions/${id(session)}`), undefined, "DELETE");
  }
  /** Read-only capability probe; v3 has no key introspection endpoint.
   * A successful scope-list proves broad access, but cannot distinguish admin
   * from workspace keys. 403 is restricted; 401 still means invalid auth. */
  async probeKeyLevel(): Promise<KeyCapability> {
    try {
      await this.request(this.workspacePath("/scopes/list"), {}, "POST", { size: 1 });
      return "workspace-or-admin";
    } catch (error) {
      if (error instanceof HonchoError && error.status === 403) return "restricted";
      throw error;
    }
  }
}

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Metadata } from "../lib/honcho-client";

type Row = Record<string, any>;
export interface MockRequest { method: string; path: string; query: Record<string, string>; body: any }
/** In-process HTTP mock. Handwritten from the v3 OpenAPI, independently of the
 * client: exact verbs, envelopes, statuses and path segments. No real secrets. */
export async function mockHoncho() {
  const requests: MockRequest[] = [];
  const workspaces = new Map<string, Row>(), peers = new Map<string, Row>(), sessions = new Map<string, Row>();
  const messages: Row[] = [], conclusions: Row[] = [];
  const scopes = new Map<string, Set<string>>();
  const faults: Array<{ status: number; body?: string; headers?: Record<string, string> }> = [];
  const now = "2026-01-01T00:00:00.000Z";
  let counter = 0;
  const matches = (row: Row, filter: Row = {}): boolean => Object.entries(filter).every(([key, expected]) => {
    if (expected && typeof expected === "object" && !Array.isArray(expected)) return matches(row[key] ?? {}, expected);
    return row[key] === expected;
  });
  const server = createServer(async (req, res) => {
    let source = "";
    for await (const chunk of req) source += chunk;
    const url = new URL(req.url!, "http://localhost");
    let body: Row = {};
    try { body = source ? JSON.parse(source) : {}; } catch { res.writeHead(422).end(); return; }
    const record = { method: req.method!, path: url.pathname, query: Object.fromEntries(url.searchParams), body };
    requests.push(record);
    const send = (status: number, value?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(value === undefined ? undefined : JSON.stringify(value));
    };
    const fault = faults.shift();
    if (fault) { send(fault.status, fault.body ?? "synthetic failure", fault.headers); return; }
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [, root, workspace, resource, resourceId, action, childId] = parts;
    if (parts[0] !== "v3" || root !== "workspaces") { send(404); return; }
    const getCreate = (map: Map<string, Row>, key: string, extras: Row = {}) => {
      if (typeof body.id !== "string") { send(422); return; }
      const row = map.get(key) ?? { id: body.id, uid: `uid_${++counter}`, metadata: body.metadata ?? {}, configuration: body.configuration ?? {}, created_at: now, ...extras };
      map.set(key, row); send(200, row);
    };
    const page = (rows: Row[]) => {
      if (url.searchParams.get("reverse") === "true") rows = [...rows].reverse();
      const size = Number(url.searchParams.get("size") ?? 50);
      const offset = url.searchParams.has("cursor") ? Number(url.searchParams.get("cursor") || 0) : (Number(url.searchParams.get("page") ?? 1) - 1) * size;
      send(200, { items: rows.slice(offset, offset + size), total: rows.length, next_page: offset + size < rows.length ? String(offset + size) : null });
    };
    if (req.method === "POST" && parts.length === 2) { getCreate(workspaces, body.id); return; }
    const key = `${workspace}/${resourceId}`;
    if (req.method === "DELETE") {
      if (resource === "sessions" && parts.length === 5) {
        sessions.delete(key);
        for (let i = messages.length - 1; i >= 0; i--) if (messages[i].workspace_id === workspace && messages[i].session_id === resourceId) messages.splice(i, 1);
        send(202, {}); return;
      }
      if (resource === "conclusions" && parts.length === 5) {
        const index = conclusions.findIndex(c => c.id === resourceId);
        if (index >= 0) conclusions.splice(index, 1);
        send(204); return;
      }
      send(404); return;
    }
    if (req.method === "PUT" && resource === "sessions" && action === "messages") {
      const message = messages.find(m => m.workspace_id === workspace && m.session_id === resourceId && m.id === childId);
      if (!message) { send(404); return; }
      message.metadata = body.metadata; send(200, message); return;
    }
    if (req.method !== "POST") { send(405); return; }
    if (resource === "peers" && parts.length === 4) { getCreate(peers, `${workspace}/${body.id}`, { workspace_id: workspace }); return; }
    if (resource === "sessions" && parts.length === 4) { getCreate(sessions, `${workspace}/${body.id}`, { workspace_id: workspace, is_active: true, peers: body.peers ?? {}, scopes: body.scopes ?? [] }); return; }
    if (resource === "sessions" && action === "peers") {
      const session = sessions.get(key);
      if (!session) { send(404); return; }
      Object.assign(session.peers, body); send(200, session); return;
    }
    if (resource === "scopes") {
      if (parts.length === 4) { scopes.set(`${workspace}/${body.id}`, scopes.get(`${workspace}/${body.id}`) ?? new Set()); send(200, { id: body.id, created_at: now }); return; }
      if (resourceId === "list") { page([...scopes.keys()].filter(k => k.startsWith(`${workspace}/`)).map(k => ({ id: k.split("/")[1], created_at: now }))); return; }
      if (action === "sessions") {
        const scope = scopes.get(key);
        if (!scope) { send(404); return; }
        for (const session of body.session_ids) scope.add(session);
        send(204); return;
      }
    }
    if (resource === "sessions" && action === "messages") {
      if (childId === "list") { page(messages.filter(m => m.workspace_id === workspace && m.session_id === resourceId && matches(m, body.filters))); return; }
      if (!Array.isArray(body.messages) || body.messages.length < 1 || body.messages.length > 100 || body.messages.some((m: Row) => typeof m.content !== "string" || m.content.length > 25000 || !m.peer_id)) { send(422); return; }
      const created = body.messages.map((m: Row) => ({ ...m, id: `msg_${++counter}`, session_id: resourceId, workspace_id: workspace, created_at: m.created_at ?? now, token_count: 1 }));
      messages.push(...created); send(201, created); return;
    }
    if (resource === "conclusions") {
      if (resourceId === "list") { page(conclusions.filter(c => matches(c, body.filters))); return; }
      if (resourceId === "query") { send(200, conclusions.filter(c => c.content.includes(body.query) && c.observer_id === body.filters?.observer && c.observed_id === body.filters?.observed).slice(0, body.top_k ?? 10)); return; }
      if (parts.length === 4 && Array.isArray(body.conclusions)) {
        const created = body.conclusions.map((c: Row) => ({ ...c, id: `con_${++counter}`, created_at: now, level: "explicit" }));
        conclusions.push(...created); send(201, created); return;
      }
    }
    if (resource === "search" || action === "search") {
      const rows = messages.filter(m => m.workspace_id === workspace
        && (resource !== "sessions" || m.session_id === resourceId)
        && (resource !== "peers" || m.peer_id === resourceId)
        && (!body.scope || scopes.get(`${workspace}/${body.scope}`)?.has(m.session_id))
        && matches(m, body.filters) && m.content.includes(body.query));
      send(200, rows.slice(0, body.limit ?? 10)); return;
    }
    if (resource === "peers" && action === "representation") { send(200, { representation: "synthetic representation" }); return; }
    if (resource === "chat" || (resource === "peers" && action === "chat")) {
      if (body.stream !== false || !body.query || !body.reasoning_level || (body.scope && (body.session_id || body.filters))) { send(422); return; }
      send(200, { content: "synthetic memory" }); return;
    }
    send(404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests, messages, conclusions, scopes,
    fault(status: number, body?: string, headers?: Record<string, string>) { faults.push({ status, body, headers }); },
    close: () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); }),
  };
}

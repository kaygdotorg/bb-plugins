// Line-based edits of ~/.codex/config.toml. No TOML dependency: the edits are
// limited to the shapes codex and codex-honcho write, and anything else is left
// byte-for-byte alone.
//
// - stripHonchoMcp: a port of codex-honcho's own stripBlock (codex-honcho.mjs,
//   src/connectors/mcp.ts), which drops only [mcp_servers.honcho*] tables from the
//   `# >>> codex-honcho` fence and keeps [tui], hooks.state and [projects…].
// - hook state tables: `[hooks.state."<key>"]` (what codex writes) and the
//   inline `"<key>" = { … }` form inside `[hooks.state]`.

export const BLOCK_START = "# >>> codex-honcho (honcho mcp) >>>";
export const BLOCK_END = "# <<< codex-honcho (honcho mcp) <<<";

const HEADER = /^\s*\[+\s*([^\]]+?)\s*\]+\s*(#.*)?$/;
const isHonchoTable = (name: string) => name === "mcp_servers.honcho" || name.startsWith("mcp_servers.honcho.");

/** codex-honcho's stripBlock, verbatim in behaviour. Content without the fence is returned unchanged. */
export function stripBlock(content: string): string {
  if (!content.includes(BLOCK_START)) return content;
  const chunks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  let dropTable = false;
  const cut = () => {
    if (current.length) { chunks.push(current.join("\n")); current = []; }
  };
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === BLOCK_START) { inFence = true; dropTable = false; cut(); continue; }
    if (trimmed === BLOCK_END) { inFence = false; dropTable = false; cut(); continue; }
    if (inFence) {
      const header = trimmed.match(HEADER);
      if (header) dropTable = isHonchoTable(header[1]!);
      if (dropTable) { cut(); continue; }
    }
    current.push(line);
  }
  cut();
  const parts = chunks.map((c) => c.replace(/^\n+/, "").replace(/\n+$/, "")).filter(Boolean);
  return parts.length ? `${parts.join("\n\n")}\n` : "";
}

/** Drops a [mcp_servers.honcho] table written by hand, outside codex-honcho's fence. */
function dropUnfencedHonchoTables(content: string): string {
  const lines = content.split("\n");
  const out: string[] = [];
  let drop = false;
  for (const line of lines) {
    const header = line.trim().match(HEADER);
    if (header) drop = isHonchoTable(normalizeDotted(header[1]!));
    if (!drop) out.push(line);
  }
  return out.join("\n");
}

const normalizeDotted = (name: string) => name.replace(/\s*\.\s*/g, ".");

/** Removes the honcho MCP server, whether codex-honcho fenced it or not. */
export function stripHonchoMcp(content: string): string {
  const stripped = stripBlock(content);
  return hasHonchoMcp(stripped) ? dropUnfencedHonchoTables(stripped) : stripped;
}

export function hasHonchoMcp(content: string): boolean {
  return content.split("\n").some((line) => {
    const header = line.trim().match(HEADER);
    return !!header && isHonchoTable(normalizeDotted(header[1]!));
  });
}

// ---------- hooks.state ----------

const STATE_HEADER = /^(\s*\[\s*hooks\s*\.\s*state\s*\.\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*\]\s*(?:#.*)?)$/;
const STATE_TABLE = /^\s*\[\s*hooks\s*\.\s*state\s*\]\s*(?:#.*)?$/;
const INLINE_ENTRY = /^(\s*)("(?:[^"\\]|\\.)*"|'[^']*')(\s*=\s*\{.*\}\s*(?:#.*)?)$/;
const TRUSTED_LINE = /^(\s*trusted_hash\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/;

function decodeKey(raw: string): string | null {
  if (raw.startsWith("'")) return raw.slice(1, -1);
  try { return JSON.parse(raw) as string; } catch { return null; }
}
const encodeKey = (key: string) => JSON.stringify(key);

export interface HookStates {
  states: Map<string, { trustedHash?: string }>;
  /** hooks.state is written in a shape these edits don't handle (an inline table or dotted keys). */
  unsupported: boolean;
}

type Line =
  | { kind: "header"; table: string; text: string }
  | { kind: "state-header"; key: string; prefix: string; suffix: string; text: string }
  | { kind: "other"; table: string; text: string };

function scan(content: string): { lines: Line[]; unsupported: boolean } {
  const lines: Line[] = [];
  let table = "";
  let unsupported = false;
  for (const text of content.split("\n")) {
    const state = text.match(STATE_HEADER);
    if (state) {
      const key = decodeKey(state[2]!);
      if (key === null) unsupported = true;
      else { table = `hooks.state.${key}`; lines.push({ kind: "state-header", key, prefix: state[1]!, suffix: state[3]!, text }); continue; }
    }
    const header = text.trim().match(HEADER);
    if (header) {
      table = normalizeDotted(header[1]!);
      lines.push({ kind: "header", table, text });
      continue;
    }
    const assign = text.match(/^\s*([A-Za-z0-9_.\-\s"']+?)\s*=/);
    if (assign && !text.trim().startsWith("#")) {
      const key = normalizeDotted(assign[1]!.trim());
      if ((table === "" && (key === "hooks" || key.startsWith("hooks.state"))) || (table === "hooks" && (key === "state" || key.startsWith("state.")))) unsupported = true;
    }
    lines.push({ kind: "other", table, text });
  }
  return { lines, unsupported };
}

function trustedFrom(text: string): string | undefined {
  const m = text.match(/trusted_hash\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/);
  return m ? decodeKey(m[1]!) ?? undefined : undefined;
}

export function readHookStates(content: string): HookStates {
  const { lines, unsupported } = scan(content);
  const states = new Map<string, { trustedHash?: string }>();
  let current: { trustedHash?: string } | null = null;
  for (const line of lines) {
    if (line.kind === "state-header") { current = {}; states.set(line.key, current); continue; }
    if (line.kind === "header") { current = null; continue; }
    if (current) {
      const m = line.text.match(TRUSTED_LINE);
      if (m) current.trustedHash = decodeKey(m[2]!) ?? undefined;
    } else if (line.table === "hooks.state") {
      const m = line.text.match(INLINE_ENTRY);
      const key = m ? decodeKey(m[2]!) : null;
      if (m && key !== null) states.set(key, { trustedHash: trustedFrom(m[3]!) });
    }
  }
  return { states, unsupported };
}

/**
 * Renames (string) or drops (null) hook state entries in one pass, so a rename
 * onto a key that is itself being renamed away never collides. Keys missing from
 * `mapping` are kept as they are.
 */
export function rekeyHookStates(content: string, mapping: Map<string, string | null>): string {
  const { lines } = scan(content);
  const out: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (line.kind === "state-header") {
      const next = mapping.has(line.key) ? mapping.get(line.key)! : line.key;
      dropping = next === null;
      if (!dropping) out.push(next === line.key ? line.text : `${line.prefix}${encodeKey(next)}${line.suffix}`);
      continue;
    }
    if (line.kind === "header") { dropping = false; out.push(line.text); continue; }
    if (dropping) continue;
    if (line.table === "hooks.state") {
      const m = line.text.match(INLINE_ENTRY);
      const key = m ? decodeKey(m[2]!) : null;
      if (m && key !== null && mapping.has(key)) {
        const next = mapping.get(key)!;
        if (next !== null) out.push(`${m[1]}${encodeKey(next)}${m[3]}`);
        continue;
      }
    }
    out.push(line.text);
  }
  return out.join("\n");
}

/** Writes `trusted_hash` for one hook key, editing an existing entry in place or appending a table. */
export function setHookTrust(content: string, key: string, hash: string): string {
  const { lines, unsupported } = scan(content);
  if (unsupported) throw new Error("hooks.state uses a TOML shape bb does not edit");
  const value = encodeKey(hash);
  const out: string[] = [];
  let state: "none" | "in" | "done" = "none";
  for (const line of lines) {
    if (state === "in" && (line.kind === "header" || line.kind === "state-header")) {
      // The table had no trusted_hash line: insert it right after the existing ones.
      let at = out.length;
      while (at > 0 && out[at - 1]!.trim() === "") at -= 1;
      out.splice(at, 0, `trusted_hash = ${value}`);
      state = "done";
    }
    if (line.kind === "state-header" && line.key === key && state === "none") { state = "in"; out.push(line.text); continue; }
    if (state === "in") {
      const m = line.text.match(TRUSTED_LINE);
      if (m) { out.push(`${m[1]}${value}${m[3]}`); state = "done"; continue; }
    }
    if (state === "none" && line.kind === "other" && line.table === "hooks.state") {
      const m = line.text.match(INLINE_ENTRY);
      if (m && decodeKey(m[2]!) === key) {
        const body = m[3]!;
        const replaced = /trusted_hash\s*=/.test(body)
          ? body.replace(/(trusted_hash\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')/, `$1${value}`)
          : body.replace(/\{\s*/, (open) => `${open}trusted_hash = ${value}, `).replace(/,\s*\}/, " }");
        out.push(`${m[1]}${m[2]}${replaced}`);
        state = "done";
        continue;
      }
    }
    out.push(line.text);
  }
  if (state === "in") {
    let at = out.length;
    while (at > 0 && out[at - 1]!.trim() === "") at -= 1;
    out.splice(at, 0, `trusted_hash = ${value}`);
    state = "done";
  }
  if (state === "done") return out.join("\n");
  const base = content.replace(/\n*$/, "");
  return `${base ? `${base}\n\n` : ""}[hooks.state.${encodeKey(key)}]\ntrusted_hash = ${value}\n`;
}

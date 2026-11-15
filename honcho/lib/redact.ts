export const REDACTED = "[REDACTED]";
export interface RedactionOptions {
  /** All config credentials and bb-secrets values, supplied by the caller. */
  deny?: Iterable<string>;
  patterns?: readonly RegExp[];
}
export interface RedactionResult { text: string; count: number }

function entropy(text: string): number {
  const frequencies = new Map<string, number>();
  for (const c of text) frequencies.set(c, (frequencies.get(c) ?? 0) + 1);
  return [...frequencies.values()].reduce((sum, n) => {
    const p = n / text.length;
    return sum - p * Math.log2(p);
  }, 0);
}

const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const BB_ID = /^(?:thr|evt|env|proj|turn|creq)_[a-z\d]+$/i;

/** Share of the token covered by dictionary-like words (`src`, `Button`, `index`): high for
 * identifiers and paths, low for random keys. */
function wordy(value: string): boolean {
  const letters = value.replace(/[\/+=_-]/g, "");
  const covered = (letters.match(/[A-Z]?[a-z]{2,}|[A-Z]{2,}(?![a-z])/g) ?? []).reduce((n, w) => n + w.length, 0);
  return letters.length > 0 && covered / letters.length >= 0.7;
}
/** base64 that decodes to readable text is an encoded string in code, not a key. */
function decodesToText(value: string): boolean {
  const bytes = Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (bytes.length < 12) return false;
  let printable = 0;
  for (const b of bytes) if ((b >= 32 && b < 127) || b === 9 || b === 10 || b === 13) printable++;
  return printable / bytes.length >= 0.9;
}
/** A hex digest or git object id the text itself labels as one. */
function labelledHex(before: string): boolean {
  return /(?:\b(?:sha(?:1|256|384|512)?|md5|blake2b?|digest|checksum|integrity|commit|rev(?:ision)?|object|blob|tree|HEAD|git|merge|cherry-pick|revert)\b[^\n]{0,24}|@sha256:|sha256-)$/i.test(before);
}

/** Context-free entropy check. Known id shapes stay: uuids, bb ids, 40-hex git object ids, and
 * hex the text labels as a digest or commit. Long hex (>= 32, e.g. `openssl rand -hex`) and
 * base64 (>= 24) are masked when they look random: high entropy, not words, not encoded text. */
function tokenLike(value: string, before: string): boolean {
  if (UUID.test(value) || BB_ID.test(value)) return false;
  if (/^[a-f\d]+$/i.test(value)) {
    if (value.length < 32 || value.length === 40 || labelledHex(before)) return false;
    return /\d/.test(value) && /[a-f]/i.test(value) && entropy(value) >= 3;
  }
  if (value.length < 24 || entropy(value) < 3.5) return false;
  if (/^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)/.test(value)) return true;
  if (!/[A-Z]/.test(value) || !/[a-z]/.test(value) || !/\d/.test(value)) return false;
  if (/[_-]/.test(value)) return !wordy(value);
  // No separators: plain base64. Paths and identifiers are wordy; encoded text decodes to text.
  return entropy(value) >= 3.8 && !wordy(value) && !decodesToText(value);
}

/** Names whose values are credentials: anything with token/secret/password/passwd/credential in it. */
const SECRET_NAME = String.raw`[A-Za-z_][\w-]*?(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)[\w-]*|(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY)[\w-]*`;
/** Names ending in a KEY component (ANTHROPIC_KEY, X-Api-Key, accessKey, key): only key-shaped values count. */
const KEY_NAME = String.raw`(?:[A-Za-z\d]+[_-])*KEY|[a-z][A-Za-z\d]*Key`;
const VALUE = String.raw`"[^"\r\n]*"|'[^'\r\n]*'`;
const TYPE_WORDS = /^(?:string|number|boolean|bigint|object|symbol|any|unknown|never|void|null|undefined|true|false|none|str|int|bool|bytes|optional|required|redacted|\[redacted\])$/i;
const unquote = (value: string) => value.replace(/^(["'])([\s\S]*)\1$/, "$2");
/** A KEY-named value must look like a key, so `sortKey = a.id` or `queryKey: "users"` stay. */
const keyShaped = (value: string) => { const v = unquote(value); return v.length >= 8 && /\d/.test(v) && /[A-Za-z]/.test(v) && !/\s/.test(v); };
/** A `name: value` pair is a credential unless the value is a type, a reference or code. */
const literalValue = (value: string) => { const v = unquote(value).trim(); return v.length > 0 && !TYPE_WORDS.test(v) && !/^[[{(<$]/.test(v) && !v.includes("("); };
/** Environment variables that never hold credentials (unless their name says so, see SECRET_NAME). */
const PLAIN_ENV = /^(?:PATH|MANPATH|INFOPATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|LANG|LANGUAGE|TZ|EDITOR|VISUAL|PAGER|PWD|OLDPWD|DISPLAY|HOSTNAME|TMPDIR|CI|DEBUG|NODE_ENV|NODE_OPTIONS|RUST_LOG|RUST_BACKTRACE|CC|CXX|CFLAGS|CXXFLAGS|LDFLAGS|LC_\w+|XDG_\w+|\w+_(?:PATH|HOME|DIR|ENV|LEVEL|MODE|VERSION|PORT|HOST))$/;

/** Longest piece of a line a user pattern is run on. */
export const USER_LINE_MAX = 10_000;
/** Longest user pattern source accepted. */
export const PATTERN_MAX = 500;

const NL_NAME = String.raw`(?:pass(?:word|code)|pin|api[ _-]?key|secret|token)`;
// The value is a quoted string or a run of non-space chars; trailing punctuation is trimmed by the caller.
const NL_SECRET = new RegExp(String.raw`(?<![\w-])${NL_NAME}\s*(?:\bis\b|=|:)\s*("[^"\r\n]{1,200}"|'[^'\r\n]{1,200}'|[^\s"'\`]{1,200})`, "gi");
/** The value after "password is": quoted text counts; a bare word must look like a credential
 * (a digit, a symbol or inner capitals, 4+ chars) so "the password is required" stays. */
function nlValue(value: string): boolean {
  if (/^(["']).+\1$/.test(value)) return value.length > 2 && !TYPE_WORDS.test(unquote(value));
  if (value.length < 4 || /^[[{(<$]/.test(value) || value.includes("(") || TYPE_WORDS.test(value)) return false;
  return /\d/.test(value) || /[^A-Za-z\d]/.test(value) || /[A-Z]/.test(value.slice(1)) && /[a-z]/.test(value);
}

/** Why a user regex is refused, or null when it passes. A cheap static check, no dependency:
 * nested unbounded quantifiers (`(a+)+`), unbounded groups of overlapping alternatives
 * (`(a|a)*`, `(.|x)+`), backreferences and lookbehind. */
export function unsafePattern(source: string): string | null {
  if (source.length > PATTERN_MAX) return `Longer than ${PATTERN_MAX} characters.`;
  if (/\\[1-9]|\\k</.test(source.replace(/\\\\/g, ""))) return "Backreferences are not allowed; they can make matching very slow.";
  if (/\(\?<[=!]/.test(source.replace(/\\./g, ""))) return "Lookbehind is not allowed.";
  interface Group { quantified: boolean; branches: string[]; atoms: string[]; first: boolean }
  const stack: Group[] = [{ quantified: false, branches: [], atoms: [], first: true }];
  const unbounded = (at: number): { open: boolean; end: number } | null => {
    const c = source[at];
    let end = at, open = false;
    if (c === "*" || c === "+") { open = true; end = at + 1; }
    else if (c === "?") end = at + 1;
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(at));
      if (!m) return null;
      end = at + m[0].length;
      open = m[2] !== undefined && (m[3] === "" || Number(m[3]) > 100);
    } else return null;
    if (source[end] === "?" || source[end] === "+") end++;
    return { open, end };
  };
  for (let i = 0; i < source.length;) {
    const c = source[i];
    const top = stack[stack.length - 1];
    let atom: string | null = null;
    if (c === "\\") { atom = source.slice(i, i + 2); i += 2; }
    else if (c === "[") {
      let j = i + 1;
      if (source[j] === "^") j++;
      if (source[j] === "]") j++;
      while (j < source.length && source[j] !== "]") j += source[j] === "\\" ? 2 : 1;
      atom = source.slice(i, j + 1); i = j + 1;
    } else if (c === "(") {
      stack.push({ quantified: false, branches: [], atoms: [], first: true });
      i++;
      if (source[i] === "?") { i++; if (source[i] === ":" || source[i] === "=" || source[i] === "!") i++; else if (source[i] === "<") { while (i < source.length && source[i] !== ">") i++; i++; } }
      continue;
    } else if (c === ")") {
      const group = stack.pop()!;
      if (!stack.length) return "Unbalanced parenthesis.";
      const q = unbounded(i + 1);
      const parent = stack[stack.length - 1];
      group.branches.push(group.atoms[0] ?? "");
      if (q?.open) {
        if (group.quantified) return "Nested repetition such as (a+)+ can make matching very slow; rewrite it without a repeated group inside a repeated group.";
        if (group.branches.length > 1 && overlapping(group.branches)) return "A repeated alternation whose branches overlap, such as (a|a)* or (.|x)+, can make matching very slow.";
      }
      if (group.quantified || q?.open) parent.quantified = true;
      i = q ? q.end : i + 1;
      parent.first = false;
      continue;
    } else if (c === "|") { top.branches.push(top.atoms[0] ?? ""); top.atoms = []; top.first = true; i++; continue; }
    else { atom = c; i++; }
    if (top.first) { top.atoms.push(atom); top.first = false; }
    const q = unbounded(i);
    if (q) { if (q.open) top.quantified = true; i = q.end; }
  }
  return stack.length === 1 ? null : "Unbalanced parenthesis.";
}
/** True when two alternatives may start with the same character: equal first atoms, or a wildcard or class. */
function overlapping(firsts: string[]): boolean {
  const wild = (a: string) => a === "." || a.startsWith("[") || /^\\[wWdDsSbB]/.test(a) || a === "";
  for (let i = 0; i < firsts.length; i++) for (let j = i + 1; j < firsts.length; j++) {
    if (firsts[i] === firsts[j] || wild(firsts[i]) || wild(firsts[j])) return true;
  }
  return false;
}

/** Counts disjoint replaced spans, including adjacent matches separately. */
export function redact(text: string, options: RedactionOptions = {}): RedactionResult {
  const spans: Array<[number, number]> = [];
  const collect = (regex: RegExp, group = 0, accept: (value: string) => boolean = () => true) => {
    const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, "") + "g");
    for (const m of text.matchAll(re)) {
      const value = m[group];
      if (!value || !accept(value)) continue;
      const start = m.index! + (group ? m[0].lastIndexOf(value) : 0);
      spans.push([start, start + value.length]);
    }
  };
  /** User patterns see one line at a time, in pieces of at most USER_LINE_MAX chars, so even a
   * pattern the static check missed has bounded input. */
  const collectBounded = (regex: RegExp) => {
    const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, "") + "g");
    let offset = 0;
    for (const line of text.split("\n")) {
      for (let from = 0; from < line.length || (from === 0 && line.length === 0); from += USER_LINE_MAX) {
        const piece = line.slice(from, from + USER_LINE_MAX);
        for (const m of piece.matchAll(re)) {
          if (!m[0]) continue;
          const start = offset + from + m.index!;
          spans.push([start, start + m[0].length]);
        }
        if (line.length === 0) break;
      }
      offset += line.length + 1;
    }
  };
  collect(/-----BEGIN ([A-Z\d ]+)-----[\s\S]*?-----END \1-----/g);
  collect(/\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+\b/g);
  collect(/\b[a-z][a-z\d+.-]*:\/\/([^\s/@]+(?::[^\s/@]*)?@)/gi, 1);
  collect(/\bAuthorization\s*:\s*([^\r\n]+)/gi, 1);
  collect(/\bBearer\s+([A-Za-z\d._~+\/-]+=*)/gi, 1);
  // NAME=value: secret names always; KEY names when the value is key-shaped.
  collect(new RegExp(String.raw`(?<![\w-])(?:export\s+)?(?:${SECRET_NAME})\s*=\s*(${VALUE}|[^\s;|&]+)`, "gi"), 1);
  collect(new RegExp(String.raw`(?<![\w-])(?:export\s+)?(?:${KEY_NAME})\s*=\s*(${VALUE}|[^\s;|&]+)`, "gi"), 1, keyShaped);
  // `export NAME=value` in commands: every value, except well-known non-secret variables.
  for (const m of text.matchAll(new RegExp(String.raw`(?<![\w-])export\s+([A-Za-z_]\w*)=(${VALUE}|[^\s;|&]+)`, "g"))) {
    if (!PLAIN_ENV.test(m[1])) spans.push([m.index! + m[0].length - m[2].length, m.index! + m[0].length]);
  }
  // name: value, YAML and JSON ("apiKey": "...", password: ...).
  collect(new RegExp(String.raw`(?<![\w-])["']?(?:${SECRET_NAME})["']?\s*:\s*(${VALUE}|[^\s,;}\]]+)`, "gi"), 1, literalValue);
  collect(new RegExp(String.raw`(?<![\w-])["']?(?:${KEY_NAME})["']?\s*:\s*(${VALUE}|[^\s,;}\]]+)`, "gi"), 1, v => literalValue(v) && keyShaped(v));
  for (const m of text.matchAll(/[A-Za-z\d_+\/-]{24,}={0,2}/g)) {
    if (tokenLike(m[0], text.slice(Math.max(0, m.index! - 48), m.index!))) spans.push([m.index!, m.index! + m[0].length]);
  }
  for (const value of options.deny ?? []) {
    if (!value || value === REDACTED) continue;
    let start = 0;
    while ((start = text.indexOf(value, start)) !== -1) {
      spans.push([start, start + value.length]);
      start += value.length;
    }
  }
  // Natural-language secrets: "my password is Hunter2x", "api key: ...", "the token = ...".
  for (const m of text.matchAll(NL_SECRET)) {
    const raw = m[1];
    const value = raw.replace(/[.,;:!?)\]}]+$/, "");
    if (!nlValue(value)) continue;
    const start = m.index! + m[0].length - raw.length;
    spans.push([start, start + value.length]);
  }
  for (const pattern of options.patterns ?? []) {
    // A pattern saved before the safety check existed is skipped rather than risk a stalled capture.
    if (unsafePattern(pattern.source) === null) collectBounded(pattern);
  }
  spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const span of spans) {
    const last = merged.at(-1);
    if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([...span]);
  }
  let result = "", offset = 0;
  for (const [start, end] of merged) {
    result += text.slice(offset, start) + REDACTED;
    offset = end;
  }
  return { text: result + text.slice(offset), count: merged.length };
}

/** Parse values without expanding shell expressions or executing dotenv. */
export function dotenvSecretValues(source: string): string[] {
  return source.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:export\s+)?[\w]+\s*=\s*(.*)$/);
    if (!match) return [];
    const value = match[1].trim();
    const quoted = value.match(/^(["'])(.*?)\1(?:\s*#.*)?$/);
    return [quoted ? quoted[2] : value.replace(/\s+#.*$/, "").trim()].filter(Boolean);
  });
}

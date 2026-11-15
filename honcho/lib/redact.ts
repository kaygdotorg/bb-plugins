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
  for (const pattern of options.patterns ?? []) collect(pattern);
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

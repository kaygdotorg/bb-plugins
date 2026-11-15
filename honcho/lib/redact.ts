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

/** Context-free entropy is deliberately conservative: ordinary base64 code
 * literals are indistinguishable from opaque credentials. Require a token
 * prefix or mixed punctuation; assignments/headers/deny values cover the rest. */
function tokenLike(value: string): boolean {
  if (/^[a-f\d]+$/i.test(value) || /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)) return false;
  if (/^(?:thr|evt|env|proj|turn|creq)_[a-z\d]+$/i.test(value)) return false;
  return value.length >= 24 && entropy(value) >= 3.5
    && ( /^(?:sk-|gh[pousr]_|github_pat_|xox[baprs]-|AKIA)/.test(value)
      || (/[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value) && /[_-]/.test(value)) );
}

/** Counts disjoint replaced spans, including adjacent matches separately. */
export function redact(text: string, options: RedactionOptions = {}): RedactionResult {
  const spans: Array<[number, number]> = [];
  const collect = (regex: RegExp, group = 0) => {
    const re = new RegExp(regex.source, regex.flags.replace(/[gy]/g, "") + "g");
    for (const m of text.matchAll(re)) {
      const value = m[group];
      if (!value) continue;
      const start = m.index! + (group ? m[0].lastIndexOf(value) : 0);
      spans.push([start, start + value.length]);
    }
  };
  collect(/-----BEGIN ([A-Z\d ]+)-----[\s\S]*?-----END \1-----/g);
  collect(/\beyJ[A-Za-z\d_-]+\.[A-Za-z\d_-]+\.[A-Za-z\d_-]+\b/g);
  collect(/\b[a-z][a-z\d+.-]*:\/\/([^\s/@]+(?::[^\s/@]*)?@)/gi, 1);
  collect(/\bAuthorization\s*:\s*([^\r\n]+)/gi, 1);
  collect(/\bBearer\s+([A-Za-z\d._~+\/-]+=*)/gi, 1);
  collect(/\b(?:export\s+)?[A-Za-z_][\w]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)[\w]*\s*=\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&]+)/gi, 1);
  // Also allow secret names with no prefix (TOKEN=..., API_KEY=...).
  collect(/\b(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY|CREDENTIAL)\s*=\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\s;|&]+)/gi, 1);
  for (const m of text.matchAll(/[A-Za-z\d_+\/-]{24,}={0,2}/g)) {
    if (tokenLike(m[0])) spans.push([m.index!, m.index! + m[0].length]);
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

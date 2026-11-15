import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// This repo is public and real bb event logs hold provider.env-resolved values, so every
// fixture and source file must stay free of anything that looks like a credential.
const root = fileURLToPath(new URL("..", import.meta.url));
// The whole honcho/ tree except installed and built output.
const SKIP_DIRS = new Set(["node_modules", "dist"]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : files(path);
    return [path];
  });
}
/** The lockfile's integrity values are public npm registry digests; everything else in it is scanned. */
const INTEGRITY = /"integrity":\s*"sha(?:1|256|384|512)-[A-Za-z0-9+/=]+"/g;
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const c of text) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.values()].reduce((sum, n) => sum - (n / text.length) * Math.log2(n / text.length), 0);
}
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/;
const PREFIXED = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})/;
/** Findings are reported by location and kind only, never by value. */
export function scanText(text: string): string[] {
  const found: string[] = [];
  if (JWT.test(text)) found.push("jwt-like token");
  if (PREFIXED.test(text)) found.push("prefixed credential");
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) found.push("private key block");
  for (const m of text.matchAll(/[A-Za-z0-9_+/=-]{32,}/g)) {
    const token = m[0];
    // Long identifiers and paths are low entropy or contain no digits; opaque tokens mix classes.
    if (/\d/.test(token) && /[a-z]/.test(token) && /[A-Z]/.test(token) && entropy(token) >= 4.2 && !/^(?:[a-z]+|[A-Z][a-z]+)+\d*$/.test(token)) found.push("high-entropy token");
  }
  return found;
}

describe("secret scan", () => {
  it("detects the shapes it guards against (tokens are assembled at runtime)", () => {
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJ0ZXN0In0", "c3ludGhldGljU2lnbmF0dXJl"].join(".");
    expect(scanText(`x ${jwt}`)).toContain("jwt-like token");
    expect(scanText(`k ${"sk" + "-Synthetic9Xv_Km4Qz8Pa2Lc7Wd6Fe"}`)).toContain("prefixed credential");
    expect(scanText(["Zk3Jq9XvT7mB2cLp", "8RwY5nHd4SfGa6UeQ1oVi0Kt"].join(""))).toContain("high-entropy token");
    expect(scanText("-----BEGIN " + "PRIVATE KEY-----")).toContain("private key block");
    expect(scanText("experimental_scanPublicSdkOnly and an_ordinary_identifier_name_that_is_long")).toEqual([]);
  });
  it("finds no credential-like value in any fixture or source file", () => {
    const hits: string[] = [];
    const all = files(root);
    expect(all.length).toBeGreaterThan(10);
    for (const file of ["server.ts", "host.ts", "package-lock.json", "DESIGN.md", "hooks/bb-honcho-hook.sh"]) expect(all.map(p => relative(root, p))).toContain(file);
    for (const path of all) {
      let text: string;
      try { text = readFileSync(path, "utf8"); } catch { continue; }
      if (path.endsWith("package-lock.json")) text = text.replace(INTEGRITY, "");
      for (const kind of new Set(scanText(text))) hits.push(`${relative(root, path)}: ${kind}`);
    }
    expect(hits).toEqual([]);
  });
});

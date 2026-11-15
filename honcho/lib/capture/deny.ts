import { homedir } from "node:os";

/** Glob to regex. `*` matches within one path segment (never `/`), `**` crosses `/`,
 * `?` is one non-`/` char, and a pattern also matches anything below it
 * (`/work/client` denies `/work/client/app`). A trailing `/**` is therefore the
 * same as no suffix. A leading `~` is the bb server's home dir. Matching is
 * case-insensitive for remotes. */
export function globMatcher(glob: string, opts: { caseInsensitive?: boolean } = {}): RegExp | null {
  let source = glob.trim();
  if (!source) return null;
  if (source === "~" || source.startsWith("~/")) source = homedir() + source.slice(1);
  source = source.replace(/(?:\/\*\*)?\/*$/, "");
  let re = "";
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "*") {
      if (source[i + 1] === "*") { while (source[i + 1] === "*") i++; re += ".*"; } else re += "[^/]*";
    }
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}(?:/.*)?$`, opts.caseInsensitive ? "i" : "");
}

export function denyReason(input: { remotes: Array<string | null | undefined>; path: string | null | undefined },
  settings: { denyRemotes: readonly string[]; denyPaths: readonly string[] }): string | null {
  for (const glob of settings.denyRemotes) {
    const re = globMatcher(glob, { caseInsensitive: true });
    if (re && input.remotes.some(r => r && (re.test(r) || re.test(r.replace(/\.git$/, ""))))) return `git remote matches deny list (${glob})`;
  }
  for (const glob of settings.denyPaths) {
    const re = globMatcher(glob);
    if (re && input.path && re.test(input.path.replace(/\/+$/, ""))) return `path matches deny list (${glob})`;
  }
  return null;
}

/** Limits on one deny entry and on a deny list. */
export const DENY_ENTRY_MAX = 1_000;
export const DENY_LIST_MAX = 200;

/** Why a deny entry is refused, or null when it is fine. A pattern also covers everything below
 * it, so one made only of `*`, `?` and `/` (or empty) would deny every thread; a path pattern
 * that matches the filesystem root does too. */
export function denyEntryProblem(entry: string, kind: "path" | "remote"): string | null {
  const glob = entry.trim();
  const what = kind === "path" ? "path" : "remote";
  if (!glob) return `Empty ${what} pattern: it would deny every thread. Remove the blank line.`;
  if (glob.length > DENY_ENTRY_MAX) return `Longer than ${DENY_ENTRY_MAX} characters.`;
  if (!glob.replace(/[*?/]/g, "").trim()) {
    return `"${glob}" would deny every thread, because a pattern also covers everything below it. Name a specific ${kind === "path" ? "directory, such as /work/client" : "remote, such as git@host:org/*"}.`;
  }
  if (kind === "path") {
    const re = globMatcher(glob);
    if (re && (re.test("") || re.test("/"))) return `"${glob}" matches the filesystem root, so it would deny every thread. Name a specific directory.`;
  }
  return null;
}

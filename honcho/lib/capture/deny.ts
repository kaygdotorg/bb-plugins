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

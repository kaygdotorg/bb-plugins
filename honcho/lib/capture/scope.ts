// Scope and deny-list facts about a thread, shared by live capture and backfill
// so both put a thread's session in exactly the same scope.

import type { PrivacySettings } from "../contract.js";
import { sessionScope } from "../mapping.js";
import { denyReason } from "./deny.js";
import { filesGitInfo, type CaptureBb, type GitInfo, type GitInfoReader } from "./ports.js";

type Env = Awaited<ReturnType<CaptureBb["sdk"]["environments"]["get"]>>;
type Project = Awaited<ReturnType<CaptureBb["sdk"]["projects"]["get"]>>;
/** The fields scope and deny need; both the thread DTO and thread list rows have them. */
export interface ThreadRef { id: string; projectId: string; environmentId: string | null }

export const scopeKey = (threadId: string) => `capture:scope:${threadId}`;

export interface ThreadFacts {
  env(thread: ThreadRef): Promise<Env | null>;
  git(thread: ThreadRef): Promise<GitInfo | null>;
  project(thread: ThreadRef): Promise<Project | null>;
  /** Repo name from the git common dir (worktrees share it), else the bb project name; slugged like claude-honcho.
   * Computed once per thread and kept, so it survives the environment going away. A thread with no
   * environment yet, or whose environment or project bb no longer has, gets the project name without
   * keeping it. A lookup that fails (host offline, bb error) rejects: nothing is guessed or kept. */
  scopeFor(thread: ThreadRef): Promise<string>;
  /** The kept scope, synchronously, once this load has resolved or read it. */
  known(threadId: string): string | null;
  /** Why the deny list covers this thread, or null. Fails closed: when the environment, project or
   * git info can't be read, it rejects with FactsUnavailable instead of answering "not denied". */
  denied(thread: ThreadRef, privacy: PrivacySettings): Promise<string | null>;
}

/** A thread fact (environment, project, git info) could not be read; retry later, upload nothing meanwhile. */
export class FactsUnavailable extends Error {
  constructor(what: string, readonly cause?: unknown) { super(`could not read the thread's ${what}; retrying`); this.name = "FactsUnavailable"; }
}

/** bb answered "no such environment/project": a definite answer, unlike a failed request. */
const isNotFound = (error: unknown) => {
  const { status, code } = (error ?? {}) as { status?: unknown; code?: unknown };
  return status === 404 || code === "environment_not_found" || code === "project_not_found";
};

export function threadFacts(bb: Pick<CaptureBb, "sdk" | "storage">, git: GitInfoReader = filesGitInfo(bb.sdk.files)): ThreadFacts {
  const envs = new Map<string, Promise<Env | null>>();
  const gits = new Map<string, Promise<GitInfo | null>>();
  const projects = new Map<string, Promise<Project | null>>();
  /** Successful lookups are cached; a failed one is dropped (so it is asked again next time) and
   * rejects with FactsUnavailable. `notFound` turns bb's definite "no such thing" into null. */
  const cached = <T>(map: Map<string, Promise<T | null>>, key: string, what: string, load: () => Promise<T>, notFound = isNotFound) => {
    let hit = map.get(key);
    if (!hit) {
      hit = load().catch(error => {
        if (notFound(error)) return null;
        map.delete(key);
        throw new FactsUnavailable(what, error);
      });
      map.set(key, hit);
    }
    return hit;
  };
  const known = new Map<string, string>();
  const facts: ThreadFacts = {
    known: id => known.get(id) ?? null,
    env: t => t.environmentId ? cached(envs, t.environmentId, "environment", () => bb.sdk.environments.get({ environmentId: t.environmentId! })) : Promise.resolve(null),
    async git(t) {
      const env = await facts.env(t);
      // The reader already maps "file not found" to absent; anything it throws is a failure.
      return env?.path && env.isGitRepo ? cached(gits, env.id, "git info", () => git({ hostId: env.hostId, path: env.path! }), () => false) : null;
    },
    project: t => cached(projects, t.projectId, "project", () => bb.sdk.projects.get({ projectId: t.projectId })),
    async scopeFor(t) {
      const hit = known.get(t.id) ?? await bb.storage.kv.get<string>(scopeKey(t.id));
      if (hit) { known.set(t.id, hit); return hit; }
      const [env, info, project] = await Promise.all([facts.env(t), facts.git(t), facts.project(t)]);
      const scope = sessionScope({ project: project?.name || t.projectId, cwd: env?.path ?? undefined, commonDir: info?.commonDir ?? null });
      // Not decided yet: keeping it would pin the project name over the repo for good.
      if (!env || (env.isGitRepo && env.path && info === null) || !project) return scope;
      await bb.storage.kv.set(scopeKey(t.id), scope);
      known.set(t.id, scope);
      return scope;
    },
    async denied(t, privacy) {
      if (!privacy.denyRemotes.length && !privacy.denyPaths.length) return null;
      const [env, info, project] = await Promise.all([facts.env(t), facts.git(t), facts.project(t)]);
      return denyReason({ remotes: [info?.remote, project?.gitRemoteUrl], path: env?.path }, privacy);
    },
  };
  return facts;
}

/** For backfill's `scopeFor` dep: the same resolver and cache live capture uses. */
export function createScopeResolver(bb: Pick<CaptureBb, "sdk" | "storage">, git?: GitInfoReader): (thread: ThreadRef) => Promise<string> {
  const facts = threadFacts(bb, git);
  return thread => facts.scopeFor(thread);
}

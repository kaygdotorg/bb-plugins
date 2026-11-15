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
   * Computed once per thread and kept, so it survives the environment going away. */
  scopeFor(thread: ThreadRef): Promise<string>;
  /** Why the deny list covers this thread, or null. */
  denied(thread: ThreadRef, privacy: PrivacySettings): Promise<string | null>;
}

export function threadFacts(bb: Pick<CaptureBb, "sdk" | "storage">, git: GitInfoReader = filesGitInfo(bb.sdk.files)): ThreadFacts {
  const envs = new Map<string, Promise<Env | null>>();
  const gits = new Map<string, Promise<GitInfo | null>>();
  const projects = new Map<string, Promise<Project | null>>();
  const cached = <T>(map: Map<string, Promise<T | null>>, key: string, load: () => Promise<T>) => {
    let hit = map.get(key);
    // Failures are not cached, so a host that was offline is asked again next time.
    if (!hit) { hit = load().catch(() => { map.delete(key); return null; }); map.set(key, hit); }
    return hit;
  };
  const facts: ThreadFacts = {
    env: t => t.environmentId ? cached(envs, t.environmentId, () => bb.sdk.environments.get({ environmentId: t.environmentId! })) : Promise.resolve(null),
    async git(t) {
      const env = await facts.env(t);
      return env?.path && env.isGitRepo ? cached(gits, env.id, () => git({ hostId: env.hostId, path: env.path! })) : null;
    },
    project: t => cached(projects, t.projectId, () => bb.sdk.projects.get({ projectId: t.projectId })),
    async scopeFor(t) {
      const saved = await bb.storage.kv.get<string>(scopeKey(t.id));
      if (saved) return saved;
      const [env, info, project] = await Promise.all([facts.env(t), facts.git(t), facts.project(t)]);
      const scope = sessionScope({ project: project?.name || t.projectId, cwd: env?.path ?? undefined, commonDir: info?.commonDir ?? null });
      await bb.storage.kv.set(scopeKey(t.id), scope);
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

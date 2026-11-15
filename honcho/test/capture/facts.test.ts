import { describe, expect, it } from "vitest";
import { denyReason, globMatcher } from "../../lib/capture/deny";
import { filesGitInfo, remoteUrl } from "../../lib/capture/ports";

describe("deny globs", () => {
  it("over-match rather than under-match", () => {
    expect(globMatcher("/work/client")!.test("/work/client/app")).toBe(true);
    expect(globMatcher("/work/client")!.test("/work/clientele")).toBe(false);
    expect(globMatcher("*acme/*", { caseInsensitive: true })!.test("git@example.test:ACME/repo.git")).toBe(true);
    expect(globMatcher("  ")).toBeNull();
    // `*` stays within a segment, `**` crosses `/`, and a path also covers everything below it.
    expect(globMatcher("/work/*/app")!.test("/work/client/app")).toBe(true);
    expect(globMatcher("/work/*/app")!.test("/work/client/sub/app")).toBe(false);
    expect(globMatcher("/work/**/app")!.test("/work/client/sub/app")).toBe(true);
    expect(globMatcher("/work/*")!.test("/work/client/deep/file")).toBe(true);
    expect(globMatcher("/work/client/**")!.test("/work/client")).toBe(true);
    expect(globMatcher("/work/cl?ent")!.test("/work/cl/ent")).toBe(false);
    expect(denyReason({ remotes: [null, "https://example.test/acme/x.git"], path: null }, { denyRemotes: ["https://example.test/acme/x"], denyPaths: [] })).toContain("remote");
    expect(denyReason({ remotes: [], path: "/a/b" }, { denyRemotes: [], denyPaths: [] })).toBeNull();
  });
});

describe("git facts through the host file API", () => {
  const files = (tree: Record<string, string>) => ({
    async read({ path }: { path: string }) {
      if (!(path in tree)) throw Object.assign(new Error("missing"), { status: 404, code: "ENOENT" });
      return { content: tree[path], contentEncoding: "utf8" as const } as any;
    },
  });
  it("follows a worktree's gitdir to the common dir and reads origin", async () => {
    const read = filesGitInfo(files({
      "/w/feature/.git": "gitdir: /src/repo/.git/worktrees/feature\n",
      "/src/repo/.git/worktrees/feature/commondir": "../..\n",
      "/src/repo/.git/config": '[core]\n\tbare = false\n[remote "upstream"]\n\turl = up.git\n[remote "origin"]\n\turl = git@example.test:me/repo.git\n',
    }));
    expect(await read({ hostId: "h", path: "/w/feature" })).toEqual({ commonDir: "/src/repo/.git", remote: "git@example.test:me/repo.git" });
  });
  it("handles a plain repo and a non-repo", async () => {
    const read = filesGitInfo(files({ "/r/.git/HEAD": "ref: refs/heads/main\n", "/r/.git/config": '[remote "x"]\n url = only.git\n' }));
    expect(await read({ hostId: "h", path: "/r" })).toEqual({ commonDir: "/r/.git", remote: "only.git" });
    expect(await read({ hostId: "h", path: "/nothing" })).toEqual({ commonDir: null, remote: null });
    expect(remoteUrl("[core]\n")).toBeNull();
  });
});

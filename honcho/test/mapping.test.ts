import { describe, expect, it } from "vitest";
import { aiPeer, repoNameFromCommonDir, scopeSlug, sessionMetadata, sessionScope, sessionPeers } from "../lib/mapping";
describe("mapping contracts", () => {
  it.each([["claude-code", "claude_code"], ["codex", "codex"], ["pi", "pi"], ["acp-goose", "acp-goose"], ["new-provider", "new-provider"]])("maps %s to %s", (provider, expected) => expect(aiPeer(provider)).toBe(expected));
  it.each([
    ["/work/repo/sub", "../.git", "repo"], ["/work/trees/feature", "/work/repo/.git", "repo"],
    ["/work/trees/feature", "/work/repo.git", "repo"], ["/work/no-repo", null, "no-repo"],
    ["/work/repo", ".git", "repo"], ["/work/trees/feature", "/work/hub", "hub"],
  ])("derives Claude repo name from %s %s", (cwd, common, expected) => expect(repoNameFromCommonDir(cwd, common)).toBe(expected));
  it("preserves Claude slug character replacement exactly", () => {
    expect(scopeSlug("My.Repo / V2__")).toBe("my-repo---v2__");
    expect(scopeSlug("My.Repo")).toMatch(/^[a-zA-Z0-9_-]+$/);
    expect(() => scopeSlug("")).toThrow(); expect(() => aiPeer("bad/id")).toThrow();
  });
  it("uses project fallback outside git and common dir across worktrees", () => {
    expect(sessionScope({ project: "My Project", cwd: "/tmp/not-repo" })).toBe("my-project");
    expect(sessionScope({ project: "ignored", cwd: "/work/tree", commonDir: "/work/Repo/.git" })).toBe("repo");
  });
  it("builds metadata without invented values or nulls", () => {
    expect(sessionMetadata({ provider: "codex", model: "model", host: "host", environment: "env", project: "proj", parentThread: "thr_parent", origin: "plugin", sideChat: true, automationId: "auto" })).toEqual({ provider: "codex", model: "model", host: "host", environment: "env", project: "proj", parentThread: "thr_parent", origin: "plugin", sideChat: true, automationId: "auto" });
    expect(sessionMetadata({ provider: "pi", model: null })).toEqual({ provider: "pi" });
  });
});

it("sets observation only on per-session peer relationships", () => {
  expect(sessionPeers("hermy", ["claude-code", "codex"])).toEqual({ hermy: { observe_me: true, observe_others: false }, claude_code: { observe_me: false, observe_others: false }, codex: { observe_me: false, observe_others: false } });
  expect(() => sessionPeers("codex", ["codex"])).toThrow();
});

it("lowercases scope slugs and keeps observation off the peer itself", () => {
  expect(scopeSlug("Honcho_Plugin.V2")).toBe("honcho_plugin-v2");
  expect(sessionScope({ project: "Client Repo" })).toBe("client-repo");
  const peers = sessionPeers("hermy", ["claude-code"]);
  expect(peers.claude_code).toEqual({ observe_me: false, observe_others: false });
  expect(peers.hermy.observe_me).toBe(true);
});

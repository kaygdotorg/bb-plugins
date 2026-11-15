// Capture and recall resolve a thread's scope through one resolver, so the
// session's scope and the scope recall searches never disagree.
import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost, makeMessageDispatchHookContext, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { createCaptureService } from "../../lib/capture/service";
import { RingActivityLog } from "../../lib/activity";
import { HonchoClient } from "../../lib/honcho-client";
import { openOutbox } from "../../lib/outbox";
import { setup, WORKTREE, worktreeSdk } from "./harness";

const testing = { createFakePluginHost, experimental_createHostEntryHarness };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const c of cleanup.splice(0)) await c(); });

const thread = { id: "thr_wt", projectId: "proj_one", environmentId: "env_wt" };

describe("one scope resolver", () => {
  it("capture's session scope and recall's search scope agree for a worktree", async () => {
    // Capture, on its own bb (its own kv), computing the scope from scratch.
    const fake = createFakePluginHost({ pluginId: "honcho", sdk: worktreeSdk() });
    cleanup.push(() => fake.harness.lifecycle.dispose());
    const capture = createCaptureService(fake.bb, {
      config: async () => ({ config: { baseUrl: "http://127.0.0.1:9", apiKey: "", workspace: "w", peerName: "hermy" }, keys: [], warnings: [] }),
      client: async () => new HonchoClient({ baseUrl: "http://127.0.0.1:9", workspace: "w" }),
      outbox: openOutbox(fake.bb.storage), activity: new RingActivityLog(),
    });
    const captured = await capture.scopeFor(thread);
    expect(captured).toBe("cool-repo");
    expect(capture.knownScope(thread.id)).toBe("cool-repo");

    // Recall, on another bb, with no ports: its default resolver is capture's.
    const s = await setup(testing, { sdk: worktreeSdk() });
    cleanup.push(() => s.close());
    const input = { threadId: thread.id, projectId: thread.projectId, environmentId: thread.environmentId, path: WORKTREE, projectName: "Repo One" };
    expect(s.internals.shared.scopes.sync(input)).toEqual({ scope: "repo-one", provisional: true });
    expect(await s.internals.shared.scopes.resolve(input)).toBe(captured);
    expect(s.internals.shared.scopes.sync(input)).toEqual({ scope: captured, provisional: false });

    // The configure path reads the same answer synchronously once it is known.
    const ctx = makePluginAgentConfigurationContext({
      thread: { id: thread.id, parentThreadId: null, sourceThreadId: null },
      project: { id: thread.projectId, name: "Repo One" }, environment: { id: thread.environmentId, path: WORKTREE }, provider: { id: "claude-code" },
    });
    await s.harness.behavior.resolveAgentConfiguration(ctx);
    expect(s.internals.shared.scopes.known(thread.id)).toBe(captured);
  });

  it("server wiring: recall reads capture's known scope and asks capture's resolver", async () => {
    const asked: string[] = [];
    const s = await setup(testing, { ports: {
      scopeFor: id => id === "thr_known" ? "from-capture" : null,
      resolveScope: async t => { asked.push(t.id); return "resolved-by-capture"; },
    } });
    cleanup.push(() => s.close());
    expect(s.internals.shared.scopes.known("thr_known")).toBe("from-capture");
    await s.harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({
      thread: { id: "thr_new", parentThreadId: null, sourceThreadId: null, originKind: null, originPluginId: null },
      project: { id: "proj_one", name: "Repo One" }, environment: { id: "env_x", path: "/synthetic/x", isGitRepo: true, hostId: "host_a" }, host: { id: "host_a" },
      input: { text: "hello", blocks: [] }, requestedExecution: { providerId: "claude-code" }, initiator: "user",
    }));
    await s.prefetch.idle();
    expect(asked).toEqual(["thr_new"]);
    expect(s.mock.requests.find(r => r.path.endsWith("/search"))!.body.scope).toBe("resolved-by-capture");
  });

  it("a thread with no environment yet keeps no scope", async () => {
    const s = await setup(testing, { sdk: worktreeSdk() });
    cleanup.push(() => s.close());
    const input = { threadId: "thr_q", projectId: "proj_one", environmentId: null, path: null, projectName: "Repo One" };
    expect(await s.internals.shared.scopes.resolve(input)).toBe("repo-one");
    expect(s.internals.shared.scopes.known("thr_q")).toBeNull();
  });
});

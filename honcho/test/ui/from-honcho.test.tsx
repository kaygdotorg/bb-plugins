// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MemoryInjection } from "../../lib/contract";
import { firstReplyOf, ownersOf } from "../../ui/from-honcho";

afterEach(cleanup);

const T0 = 1_700_000_000_000;
const msg = (id: string, createdAt: number, role: "user" | "assistant" = "user", turnId: string | null = "u1") =>
  (role === "user" ? { id, threadId: "t1", createdAt, turnId, role, initiator: "user" } : { id, threadId: "t1", createdAt, turnId, role }) as never;
const turn = (at: number, patch: Partial<MemoryInjection> = {}): MemoryInjection => ({
  kind: "turn", at, scope: "bb-plugins", items: [
    { content: "prefers small commits", date: "2026-11-01", sourceThreadId: "t9", sourceTitle: "release notes" },
    { content: "uses vitest", date: null, sourceThreadId: null, sourceTitle: null },
    { content: "lowercase copy", date: null, sourceThreadId: null, sourceTitle: null },
  ], ...patch,
});
const session = (at: number): MemoryInjection => ({ kind: "session", at, scope: "bb-plugins", items: [], card: ["peer card: kayg", "directive: be brief"] });

async function registration() {
  const a = await loadPluginApp(() => import("../../app"));
  const r = a.messageMetadata.find((m) => m.id === "from-honcho")!;
  return r;
}

async function mount(messages: unknown[], injections: MemoryInjection[]) {
  const r = await registration();
  const Many = () => <>{messages.map((m, n) => <div key={n} data-testid={`m${n}`}><r.component message={m as never} /></div>)}</>;
  return renderSlot({ component: Many }, {}, { rpc: { "recall.injections": () => injections } });
}

describe("registration", () => {
  it("is a quiet block above the message (the reply)", async () => {
    const r = await registration();
    expect(r.placement).toBe("above");
  });
});

describe("matching window", () => {
  const users = [{ id: "a", createdAt: T0 }, { id: "b", createdAt: T0 + 300_000 }];
  it("turn: greatest createdAt not after the injection, within 120s", () => {
    expect(ownersOf(turn(T0 + 1000), users)?.id).toBe("a");
    expect(ownersOf(turn(T0 + 120_000), users)?.id).toBe("a");
    expect(ownersOf(turn(T0 + 120_001), users)).toBeNull();
    expect(ownersOf(turn(T0 + 300_500), users)?.id).toBe("b");
    expect(ownersOf(turn(T0 - 1), users)).toBeNull();
  });
  it("session: first message from 5s before the injection, within 120s", () => {
    expect(ownersOf(session(T0 + 5000), users)?.id).toBe("a");
    expect(ownersOf(session(T0 + 5001), users)).toBeNull();
    expect(ownersOf(session(T0 + 5001), [...users, { id: "c", createdAt: T0 + 60_000 }])?.id).toBe("c");
    expect(ownersOf(session(T0 + 5001), [{ id: "a", createdAt: T0 }])).toBeNull();
    expect(ownersOf(session(T0 - 120_000), [{ id: "a", createdAt: T0 }])?.id).toBe("a");
    expect(ownersOf(session(T0 - 120_001), [{ id: "a", createdAt: T0 }])).toBeNull();
  });
});

describe("first reply", () => {
  const u = { id: "a", createdAt: T0, turnId: "t-a" };
  const next = { id: "b", createdAt: T0 + 60_000, turnId: "t-b" };
  it("prefers turnId equality", () => {
    const as = [{ id: "r2", createdAt: T0 + 9000, turnId: "t-a" }, { id: "r1", createdAt: T0 + 5000, turnId: "t-a" }, { id: "x", createdAt: T0 + 1000, turnId: "t-z" }];
    expect(firstReplyOf(u, [u, next], as)?.id).toBe("r1");
  });
  it("falls back to the first assistant before the next user message", () => {
    const nt = { id: "a", createdAt: T0, turnId: null };
    expect(firstReplyOf(nt, [nt, next], [{ id: "r2", createdAt: T0 + 9000 }, { id: "r1", createdAt: T0 + 5000 }, { id: "late", createdAt: T0 + 61_000 }])?.id).toBe("r1");
    expect(firstReplyOf(nt, [nt, next], [{ id: "late", createdAt: T0 + 61_000 }, { id: "early", createdAt: T0 - 1 }])).toBeNull();
  });
});

describe("from honcho chip", () => {
  const SESSION_TURN = [session(T0 + 1000), turn(T0 + 2000)];
  it("renders on the assistant reply, not the user message", async () => {
    const slot = await mount([msg("a", T0), msg("r", T0 + 3000, "assistant")], [turn(T0 + 2000)]);
    expect(await slot.findByText("from honcho · 3 memories · group bb-plugins")).toBeTruthy();
    expect(slot.container.querySelector('[data-testid="m0"]')!.textContent).toBe("");
    expect(slot.container.querySelector('[data-testid="m1"]')!.textContent).toMatch(/from honcho/);
  });

  it("renders nothing before the reply exists", async () => {
    const slot = await mount([msg("a", T0)], [turn(T0 + 2000)]);
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.container.textContent).toBe("");
  });

  it("renders nothing for an unmatched turn", async () => {
    const slot = await mount([msg("a", T0), msg("r", T0 + 3000, "assistant")], [turn(T0 + 500_000)]);
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.container.textContent).toBe("");
  });

  it("merges session and turn into one line, on the first reply only", async () => {
    const slot = await mount([msg("a", T0), msg("r1", T0 + 3000, "assistant"), msg("r2", T0 + 4000, "assistant")], SESSION_TURN);
    expect(await slot.findByText("from honcho · session memory + 3 memories · group bb-plugins")).toBeTruthy();
    expect(slot.queryAllByText(/from honcho/)).toHaveLength(1);
    expect(slot.container.querySelector('[data-testid="m1"]')!.textContent).toMatch(/from honcho/);
    expect(slot.container.querySelector('[data-testid="m2"]')!.textContent).toBe("");
  });

  it("shows the turn's scope when scopes differ", async () => {
    const slot = await mount([msg("a", T0), msg("r", T0 + 3000, "assistant")], [session(T0 + 1000), turn(T0 + 2000, { scope: "infraternal" })]);
    expect(await slot.findByText("from honcho · session memory + 3 memories · group infraternal")).toBeTruthy();
  });

  it("expanding shows session card lines first, then the turn excerpts", async () => {
    const slot = await mount([msg("a", T0), msg("r", T0 + 3000, "assistant")], SESSION_TURN);
    fireEvent.click(await slot.findByText(/session memory \+ 3 memories/));
    expect(slot.getByText("peer card: kayg")).toBeTruthy();
    expect(slot.getByText("2026-11-01")).toBeTruthy();
    const text = slot.container.textContent!;
    expect(text.indexOf("peer card: kayg")).toBeLessThan(text.indexOf("prefers small commits"));
    fireEvent.click(slot.getByText("release notes"));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "t9" });
    fireEvent.click(slot.getByText("open memory"));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "memory" });
  });

  it("session only", async () => {
    const slot = await mount([msg("a", T0), msg("r", T0 + 3000, "assistant")], [session(T0 + 1000)]);
    fireEvent.click(await slot.findByText("from honcho · session memory · group bb-plugins"));
    expect(slot.getByText("directive: be brief")).toBeTruthy();
    expect(slot.queryByText("prefers small commits")).toBeNull();
  });

  it("turn only, collapsed by default", async () => {
    const slot = await mount([msg("a", T0), msg("r", T0 + 3000, "assistant")], [turn(T0 + 2000, { items: [{ content: "one", date: null, sourceThreadId: null, sourceTitle: null }] })]);
    expect(await slot.findByText("from honcho · 1 memory · group bb-plugins")).toBeTruthy();
    expect(slot.queryByText("one")).toBeNull();
  });

  it("matches by turnId, and by time when there is none", async () => {
    const byTurn = await mount([msg("a", T0, "user", "A"), msg("b", T0 + 300_000, "user", "B"), msg("rb", T0 + 301_000, "assistant", "B"), msg("ra", T0 + 302_000, "assistant", "A")], [turn(T0 + 2000)]);
    await byTurn.findByText(/from honcho/);
    expect(byTurn.container.querySelector('[data-testid="m3"]')!.textContent).toMatch(/from honcho/);
    expect(byTurn.container.querySelector('[data-testid="m2"]')!.textContent).toBe("");
    cleanup();
    const byTime = await mount([msg("a", T0, "user", null), msg("r1", T0 + 3000, "assistant", null), msg("r2", T0 + 4000, "assistant", null)], [turn(T0 + 2000)]);
    await byTime.findByText(/from honcho/);
    expect(byTime.container.querySelector('[data-testid="m1"]')!.textContent).toMatch(/from honcho/);
    expect(byTime.container.querySelector('[data-testid="m2"]')!.textContent).toBe("");
  });

  it("makes one fetch for many messages", async () => {
    const many = Array.from({ length: 25 }, (_, n) => [msg(`u${n}`, T0 + n * 2000, "user", `t${n}`), msg(`r${n}`, T0 + n * 2000 + 500, "assistant", `t${n}`)]).flat();
    const slot = await mount(many, [turn(T0 + 24 * 2000 + 200)]);
    await slot.findByText(/from honcho/);
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "recall.injections")).toHaveLength(1);
    await slot.behavior.emitRealtime("activity", {});
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "recall.injections")).toHaveLength(2));
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { MemoryInjection } from "../../lib/contract";
import { ownersOf } from "../../ui/from-honcho";

afterEach(cleanup);

const T0 = 1_700_000_000_000;
const msg = (id: string, createdAt: number, role: "user" | "assistant" = "user") =>
  (role === "user" ? { id, threadId: "t1", createdAt, turnId: "u1", role, initiator: "user" } : { id, threadId: "t1", createdAt, turnId: "u1", role }) as never;
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
  it("is a quiet block above the message", async () => {
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

describe("from honcho chip", () => {
  it("renders nothing for an unmatched message and for assistant messages", async () => {
    const slot = await mount([msg("a", T0), msg("x", T0, "assistant")], [turn(T0 + 500_000)]);
    await waitFor(() => expect(slot.inspection.rpcCalls.length).toBeGreaterThan(0));
    expect(slot.container.textContent).toBe("");
  });

  it("shows a collapsed turn chip on the matched message only", async () => {
    const slot = await mount([msg("a", T0), msg("b", T0 + 300_000)], [turn(T0 + 2000)]);
    expect(await slot.findByText("from honcho · 3 memories · scope bb-plugins")).toBeTruthy();
    expect(slot.queryAllByText(/from honcho/)).toHaveLength(1);
    expect(slot.container.querySelector('[data-testid="m0"]')!.textContent).toMatch(/from honcho/);
    expect(slot.queryByText("prefers small commits")).toBeNull();
  });

  it("shows the session chip, and expanding shows the card lines", async () => {
    const slot = await mount([msg("a", T0)], [session(T0 + 1000)]);
    fireEvent.click(await slot.findByText("from honcho · session memory · scope bb-plugins"));
    expect(slot.getByText("peer card: kayg")).toBeTruthy();
    expect(slot.getByText("directive: be brief")).toBeTruthy();
    fireEvent.click(slot.getByText("open memory"));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toPluginPanel", path: "memory" });
  });

  it("expanding a turn chip shows excerpts, dates and source chats", async () => {
    const slot = await mount([msg("a", T0)], [turn(T0 + 1000)]);
    fireEvent.click(await slot.findByText(/3 memories/));
    expect(slot.getByText("prefers small commits")).toBeTruthy();
    expect(slot.getByText("2026-11-01")).toBeTruthy();
    fireEvent.click(slot.getByText("release notes"));
    expect(slot.inspection.navigateCalls.at(-1)).toMatchObject({ method: "toThread", threadId: "t9" });
    expect(slot.getAllByText("untitled chat").length).toBeGreaterThan(0);
  });

  it("makes one fetch for many messages", async () => {
    const many = Array.from({ length: 50 }, (_, n) => msg(`m${n}`, T0 + n * 1000));
    const slot = await mount(many, [turn(T0 + 49_500)]);
    await slot.findByText(/from honcho/);
    expect(slot.inspection.rpcCalls.filter((c) => c.method === "recall.injections")).toHaveLength(1);
    await slot.behavior.emitRealtime("activity", {});
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((c) => c.method === "recall.injections")).toHaveLength(2));
  });
});

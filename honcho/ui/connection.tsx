import { useEffect, useState } from "react";
import type { HarnessState, RpcMethods } from "../lib/contract";
import { useAction, useLabels, useMemoryRpc, useNow, useRemote } from "./data";
import { ago, plural } from "./format";
import { ThreadLink } from "./links";
import { Badge, Button, Card, Field, Loading, Offline, Progress, Section } from "./primitives";

const KEY_LEVEL = { "workspace-or-admin": "can use everything", restricted: "limited access, some tools are off", unknown: "not checked yet" } as const;
const KEY_SOURCE = { "config-file": "from your honcho settings file", "bb-secret": "saved in bb", none: "no key" } as const;

/** The old honcho plugin saved into one chat after bb took over. Says what to expect and links the chat. */
function OldPluginNotice({ message }: { message: string }) {
  const id = message.match(/thread (\S+)$/)?.[1] ?? null;
  const labels = useLabels(id ? [id] : []);
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-destructive/15 px-2 py-0.5 text-2xs text-destructive">
      <span>the old honcho plugin is still saving one chat. it stops by itself after that chat restarts.</span>
      {id ? <ThreadLink id={id} title={labels.thread(id)} className="text-2xs text-destructive underline" /> : null}
    </span>
  );
}

function Server() {
  const rpc = useMemoryRpc();
  const conn = useRemote("connection.get", {});
  const health = useRemote("health", {});
  const now = useNow();
  const { busy, run } = useAction();
  const [test, setTest] = useState<{ ok: boolean; latencyMs: number | null; error?: string } | null>(null);
  return (
    <Section title="memory server" actions={
      <Button disabled={busy !== null} onClick={() => void run("test", async () => { setTest(await rpc.call("connection.test", {})); await conn.refetch(); })}>{busy === "test" ? "testing…" : "test connection"}</Button>
    }>
      {conn.data === null ? (
        conn.error ? <Offline message={conn.error} onRetry={() => void conn.refetch()} /> : <Loading what="connection" />
      ) : (
        <Card className="px-3 py-1.5">
          <dl>
            <Field label="kind">{conn.data.preset === "cloud" ? "honcho cloud" : "your own server"}</Field>
            <Field label="address"><span className="font-mono">{conn.data.baseUrl}</span></Field>
            <Field label="workspace"><span title="the shared space on the server that holds your memory">{conn.data.workspace}</span></Field>
            <Field label="your name"><span title="the name memory saves you under">{conn.data.peerName}</span></Field>
            <Field label="key"><span>{KEY_SOURCE[conn.data.keySource]}</span> <span className="text-muted-foreground">· {KEY_LEVEL[conn.data.keyLevel]}</span></Field>
          </dl>
          {conn.data.warnings.length ? (
            <ul className="space-y-0.5 border-t border-border py-1.5" aria-label="warnings">
              {conn.data.warnings.map((w) => <li key={w} className="text-2xs text-warning">{w}</li>)}
            </ul>
          ) : null}
        </Card>
      )}
      {test ? (
        <p role="status" className={`text-2xs ${test.ok ? "text-muted-foreground" : "text-destructive"}`}>
          {test.ok ? `connected${test.latencyMs !== null ? ` · ${test.latencyMs} ms` : ""}` : `can't connect · ${test.error ?? "failed"}`}
        </p>
      ) : null}
      {health.data ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="health">
          <Badge>{plural(health.data.queued, "message")} waiting to be saved</Badge>
          <Badge tone={health.data.oldestPendingAt ? "warn" : "neutral"}>{health.data.oldestPendingAt ? `oldest has waited ${ago(health.data.oldestPendingAt, now).replace(" ago", "")}` : "nothing waiting"}</Badge>
          <Badge tone={health.data.authFailing ? "bad" : "good"}>{health.data.authFailing ? "login rejected" : "login works"}</Badge>
          {health.data.tripwire ? <OldPluginNotice message={health.data.tripwire} /> : null}
        </div>
      ) : null}
    </Section>
  );
}

function Step({ title, text, badges, action }: { title: string; text: string; badges: React.ReactNode; action: React.ReactNode }) {
  return (
    <div className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium">{title}</span>
        <span className="flex flex-1 flex-wrap items-center gap-1">{badges}</span>
        {action}
      </div>
      <p className="text-2xs text-muted-foreground">{text}</p>
    </div>
  );
}

function Harness() {
  const rpc = useMemoryRpc();
  const state = useRemote("harness.state", {});
  const { busy, error, run } = useAction();
  const [fresh, setFresh] = useState<HarnessState | null>(null);
  useEffect(() => { if (state.data) setFresh(null); }, [state.data]);
  const s = fresh ?? state.data;
  const call = (name: "harness.connect" | "harness.handOver") => void run(name, async () => { setFresh(await rpc.call(name, {})); await state.refetch(); });
  const undo = (step: "connect" | "handOver") => void run(`undo-${step}`, async () => { setFresh(await rpc.call("harness.undo", { step })); await state.refetch(); });
  const yes = (on: boolean, word: string, off: string) => <Badge tone={on ? "good" : "neutral"}>{on ? word : off}</Badge>;
  return (
    <Section title="assistants on this computer" hint={s ? `${s.machineId}` : undefined}>
      {s === null ? (
        state.error ? <Offline message={state.error} onRetry={() => void state.refetch()} /> : <Loading what="assistant setup" />
      ) : (
        <Card className="divide-y divide-border">
          <Step
            title="let assistants use memory"
            text="adds a small helper to claude code and codex so they get memory from bb. it does nothing outside bb chats."
            badges={<>{yes(s.claude.hookInstalled, "claude code: on", "claude code: off")}{yes(s.codex.hookInstalled, "codex: on", "codex: off")}{s.codex.trusted === false ? <Badge tone="warn" title="codex asks you to approve new helpers. open codex once and approve it">codex needs your approval</Badge> : null}</>}
            action={<>
              <Button variant="ghost" aria-label="undo turning on memory" disabled={busy !== null || (!s.claude.hookInstalled && !s.codex.hookInstalled)} onClick={() => undo("connect")}>undo</Button>
              <Button disabled={busy !== null} onClick={() => call("harness.connect")}>turn on</Button>
            </>}
          />
          <Step
            title="stop the old honcho plugins"
            text="turns off the old honcho add-ons for claude code and codex on this machine, so bb is the only thing saving to memory. your settings are backed up first."
            badges={<>{yes(s.claude.handedOver, "claude code: old plugin off", "claude code: old plugin on")}{yes(s.codex.handedOver, "codex: old plugin off", "codex: old plugin on")}</>}
            action={<>
              <Button variant="ghost" aria-label="undo turning off the old plugins" disabled={busy !== null || (!s.claude.handedOver && !s.codex.handedOver)} onClick={() => undo("handOver")}>undo</Button>
              <Button disabled={busy !== null} onClick={() => call("harness.handOver")}>turn them off</Button>
            </>}
          />
          <p className="px-3 py-2 text-2xs text-muted-foreground">each undo puts back what its own step changed, using backups bb made{s.backups.length ? ` (${plural(s.backups.length, "backup")})` : ""}.</p>
        </Card>
      )}
      {error ? <p className="text-2xs text-destructive">{error}</p> : null}
    </Section>
  );
}

function Backfill() {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const [plan, setPlan] = useState<RpcMethods["backfill.dryRun"][1] | null>(null);
  const progress = useRemote("backfill.progress", {}, { pollMs: 3000 });
  const p = progress.data;
  return (
    <Section title="import past chats" hint="save chats from before memory was turned on.">
      <Card className="space-y-2.5 p-3">
        {plan ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-5" aria-label="what an import would do">
            {([["chats it will save", plan.threads], ["messages it will save", plan.messages], ["amount of text (tokens)", plan.tokens], ["already saved, skipped", plan.skippedAlreadyInHoncho], ["not seen yet, skipped for now", plan.notYetSeenByCapture ?? 0], ["messages that include the agent's thinking", plan.reasoningMessages]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-2xs text-muted-foreground">{k}</dt><dd className="text-xs tabular-nums">{v.toLocaleString()}</dd></div>
            ))}
          </dl>
        ) : <p className="text-2xs text-muted-foreground">press "check first" to see what an import would save. it only counts and changes nothing.</p>}
        {p && (p.running || p.total > 0) ? (
          <div className="space-y-1">
            <Progress value={p.done} max={p.total} label="import progress" />
            <p className="text-2xs text-muted-foreground">{p.running ? "importing" : "stopped"} · {p.done.toLocaleString()} of {p.total.toLocaleString()} messages</p>
          </div>
        ) : null}
        {p?.error ? <p className="text-2xs text-destructive">{p.error}</p> : null}
        <div className="flex items-center gap-2">
          <Button disabled={busy !== null || p?.running === true} onClick={() => void run("dry", async () => setPlan(await rpc.call("backfill.dryRun", {})))}>check first</Button>
          {p?.running ? (
            <Button variant="danger" disabled={busy !== null} onClick={() => void run("stop", async () => { await rpc.call("backfill.stop", {}); await progress.refetch(); })}>stop</Button>
          ) : (
            <Button disabled={busy !== null || !plan || plan.messages === 0} onClick={() => void run("start", async () => { await rpc.call("backfill.start", {}); await progress.refetch(); })}>import</Button>
          )}
          {plan && plan.messages === 0 ? <span className="text-2xs text-muted-foreground">nothing to import</span> : null}
          {error ? <span className="text-2xs text-destructive">{error}</span> : null}
        </div>
      </Card>
    </Section>
  );
}

export function ConnectionTab() {
  return (
    <div className="space-y-5">
      <Server />
      <Harness />
      <Backfill />
    </div>
  );
}

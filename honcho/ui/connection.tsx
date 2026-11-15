import { useEffect, useState } from "react";
import type { HarnessState, RpcMethods } from "../lib/contract";
import { useAction, useMemoryRpc, useNow, useRemote } from "./data";
import { ago, plural } from "./format";
import { Badge, Button, Card, Field, Loading, Offline, Progress, Section } from "./primitives";

const KEY_LEVEL = { "workspace-or-admin": "workspace or admin", restricted: "restricted", unknown: "unknown" } as const;
const KEY_SOURCE = { "config-file": "~/.honcho/config.json", "bb-secret": "bb secret", none: "no key" } as const;

function Server() {
  const rpc = useMemoryRpc();
  const conn = useRemote("connection.get", {});
  const health = useRemote("health", {});
  const now = useNow();
  const { busy, run } = useAction();
  const [test, setTest] = useState<{ ok: boolean; latencyMs: number | null; error?: string } | null>(null);
  return (
    <Section title="server" actions={
      <Button disabled={busy !== null} onClick={() => void run("test", async () => { setTest(await rpc.call("connection.test", {})); await conn.refetch(); })}>{busy === "test" ? "testing…" : "test connection"}</Button>
    }>
      {conn.data === null ? (
        conn.error ? <Offline message={conn.error} onRetry={() => void conn.refetch()} /> : <Loading what="connection" />
      ) : (
        <Card className="px-3 py-1.5">
          <dl>
            <Field label="preset">{conn.data.preset === "cloud" ? "cloud" : "self-hosted"}</Field>
            <Field label="url"><span className="font-mono">{conn.data.baseUrl}</span></Field>
            <Field label="workspace">{conn.data.workspace}</Field>
            <Field label="peer">{conn.data.peerName}</Field>
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
          {test.ok ? `connected${test.latencyMs !== null ? ` · ${test.latencyMs} ms` : ""}` : `not connected · ${test.error ?? "failed"}`}
        </p>
      ) : null}
      {health.data ? (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="health">
          <Badge>{plural(health.data.queued, "message")} queued</Badge>
          <Badge tone={health.data.oldestPendingAt ? "warn" : "neutral"}>{health.data.oldestPendingAt ? `oldest ${ago(health.data.oldestPendingAt, now)}` : "nothing waiting"}</Badge>
          <Badge tone={health.data.authFailing ? "bad" : "good"}>{health.data.authFailing ? "auth failing" : "auth ok"}</Badge>
          {health.data.tripwire ? <Badge tone="bad" title={health.data.tripwire}>tripwire</Badge> : null}
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
    <Section title="harnesses" hint={s ? `this machine · ${s.machineId}` : undefined}>
      {s === null ? (
        state.error ? <Offline message={state.error} onRetry={() => void state.refetch()} /> : <Loading what="harness state" />
      ) : (
        <Card className="divide-y divide-border">
          <Step
            title="connect harnesses"
            text="installs the bb hook so claude code and codex get memory from bb. it does nothing outside bb threads."
            badges={<>{yes(s.claude.hookInstalled, "claude hook on", "claude hook off")}{yes(s.codex.hookInstalled, "codex hook on", "codex hook off")}{s.codex.trusted === false ? <Badge tone="warn" title="codex hasn't trusted the hook yet">codex untrusted</Badge> : null}</>}
            action={<>
              <Button variant="ghost" aria-label="undo connect" disabled={busy !== null || (!s.claude.hookInstalled && !s.codex.hookInstalled)} onClick={() => undo("connect")}>undo</Button>
              <Button disabled={busy !== null} onClick={() => call("harness.connect")}>connect harnesses</Button>
            </>}
          />
          <Step
            title="hand over to bb"
            text="turns off the cli honcho plugins on this machine, so bb is the only thing writing to honcho. configs are backed up first."
            badges={<>{yes(s.claude.handedOver, "claude handed over", "claude cli active")}{yes(s.codex.handedOver, "codex handed over", "codex cli active")}</>}
            action={<>
              <Button variant="ghost" aria-label="undo hand over" disabled={busy !== null || (!s.claude.handedOver && !s.codex.handedOver)} onClick={() => undo("handOver")}>undo</Button>
              <Button disabled={busy !== null} onClick={() => call("harness.handOver")}>hand over to bb</Button>
            </>}
          />
          <p className="px-3 py-2 text-2xs text-muted-foreground">each undo reverts its own step from bb's backups{s.backups.length ? ` (${plural(s.backups.length, "backup")})` : ""}.</p>
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
    <Section title="backfill" hint="upload threads that already existed before memory was on.">
      <Card className="space-y-2.5 p-3">
        {plan ? (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 sm:grid-cols-5" aria-label="dry run">
            {([["threads", plan.threads], ["messages", plan.messages], ["tokens", plan.tokens], ["already there", plan.skippedAlreadyInHoncho], ["with reasoning", plan.reasoningMessages]] as const).map(([k, v]) => (
              <div key={k}><dt className="text-2xs text-muted-foreground">{k}</dt><dd className="text-xs tabular-nums">{v.toLocaleString()}</dd></div>
            ))}
          </dl>
        ) : <p className="text-2xs text-muted-foreground">run a dry run first. it counts what would be uploaded and changes nothing.</p>}
        {p && (p.running || p.total > 0) ? (
          <div className="space-y-1">
            <Progress value={p.done} max={p.total} label="backfill progress" />
            <p className="text-2xs text-muted-foreground">{p.running ? "running" : "stopped"} · {p.done.toLocaleString()} of {p.total.toLocaleString()}</p>
          </div>
        ) : null}
        {p?.error ? <p className="text-2xs text-destructive">{p.error}</p> : null}
        <div className="flex items-center gap-2">
          <Button disabled={busy !== null || p?.running === true} onClick={() => void run("dry", async () => setPlan(await rpc.call("backfill.dryRun", {})))}>dry run</Button>
          {p?.running ? (
            <Button variant="danger" disabled={busy !== null} onClick={() => void run("stop", async () => { await rpc.call("backfill.stop", {}); await progress.refetch(); })}>stop</Button>
          ) : (
            <Button disabled={busy !== null || !plan || plan.messages === 0} onClick={() => void run("start", async () => { await rpc.call("backfill.start", {}); await progress.refetch(); })}>start</Button>
          )}
          {plan && plan.messages === 0 ? <span className="text-2xs text-muted-foreground">nothing to upload</span> : null}
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

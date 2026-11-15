import { useEffect, useState } from "react";
import type { PrivacySettings } from "../lib/contract";
import { useAction, useMemoryRpc, useRemote } from "./data";
import { ago } from "./format";
import { Button, Card, Empty, Loading, Offline, Section, Switch, inputClass } from "./primitives";

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

function Pauses() {
  const rpc = useMemoryRpc();
  const pauses = useRemote("pause.list", {});
  const { busy, error, run } = useAction();
  return (
    <Section title="pauses" hint="paused threads and projects are never queued or uploaded. nothing earlier is deleted.">
      {pauses.data === null ? (
        pauses.error ? <Offline message={pauses.error} onRetry={() => void pauses.refetch()} /> : <Loading what="pauses" />
      ) : pauses.data.length === 0 ? (
        <Empty title="nothing is paused" />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card" aria-label="pauses">
          {pauses.data.map((p) => (
            <li key={`${p.kind}:${p.id}`} className="flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
              <span className="w-14 shrink-0 text-2xs text-muted-foreground">{p.kind}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{p.id}</span>
              <span className="shrink-0 text-2xs text-muted-foreground">paused {ago(p.since)}</span>
              <Button variant="ghost" className="h-6 px-1.5" disabled={busy !== null} onClick={() => void run(p.id, async () => { await rpc.call("pause.set", { kind: p.kind, id: p.id, paused: false }); await pauses.refetch(); })}>unpause</Button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-2xs text-destructive">{error}</p> : null}
    </Section>
  );
}

function Rules({ settings, onSaved }: { settings: PrivacySettings; onSaved(): void }) {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const [remotes, setRemotes] = useState(settings.denyRemotes.join("\n"));
  const [paths, setPaths] = useState(settings.denyPaths.join("\n"));
  const [patterns, setPatterns] = useState(settings.patterns.join("\n"));
  useEffect(() => {
    setRemotes(settings.denyRemotes.join("\n"));
    setPaths(settings.denyPaths.join("\n"));
    setPatterns(settings.patterns.join("\n"));
  }, [settings]);
  const dirty = remotes !== settings.denyRemotes.join("\n") || paths !== settings.denyPaths.join("\n") || patterns !== settings.patterns.join("\n");
  const box = (label: string, hint: string, value: string, set: (v: string) => void) => (
    <label className="block space-y-1">
      <span className="text-xs">{label}</span>
      <span className="block text-2xs text-muted-foreground">{hint}</span>
      <textarea aria-label={label} className={`${inputClass} min-h-16 font-mono`} value={value} onChange={(e) => set(e.target.value)} spellCheck={false} />
    </label>
  );
  return (
    <Section title="never capture or redact" hint="one entry per line.">
      <Card className="space-y-3 p-3">
        {box("deny remotes", "git remote globs, e.g. git@github.com:client/*", remotes, setRemotes)}
        {box("deny paths", "environment path globs, e.g. /work/client/**. * stays within one folder, ** crosses folders; a path also covers everything below it", paths, setPaths)}
        {box("regex patterns", "matches are replaced with [REDACTED] before upload", patterns, setPatterns)}
        <div className="flex items-center gap-2">
          <Button disabled={!dirty || busy !== null} onClick={() => void run("save", async () => {
            await rpc.call("privacy.set", { denyRemotes: lines(remotes), denyPaths: lines(paths), patterns: lines(patterns) });
            onSaved();
          })}>save</Button>
          {error ? <span className="text-2xs text-destructive">{error}</span> : dirty ? <span className="text-2xs text-muted-foreground">unsaved changes</span> : null}
        </div>
      </Card>
    </Section>
  );
}

function TestBox() {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ text: string; count: number } | null>(null);
  return (
    <Section title="test on text" hint="runs your patterns and the credentials in your honcho config. nothing is uploaded.">
      <Card className="space-y-2 p-3">
        <textarea aria-label="text to test" className={`${inputClass} min-h-16 font-mono`} placeholder="paste something that might hold a secret" value={text} onChange={(e) => { setText(e.target.value); setResult(null); }} spellCheck={false} />
        <div className="flex items-center gap-2">
          <Button disabled={busy !== null || !text} onClick={() => void run("test", async () => setResult(await rpc.call("privacy.test", { text })))}>test</Button>
          {result ? <span role="status" className="text-2xs text-muted-foreground">{result.count === 0 ? "nothing redacted" : `${result.count} redacted`}</span> : null}
          {error ? <span className="text-2xs text-destructive">{error}</span> : null}
        </div>
        {result ? <pre aria-label="redacted output" className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{result.text}</pre> : null}
      </Card>
    </Section>
  );
}

function Deletes({ settings, onSaved }: { settings: PrivacySettings; onSaved(): void }) {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const set = (patch: Partial<PrivacySettings>) => void run("toggle", async () => { await rpc.call("privacy.set", patch); onSaved(); });
  return (
    <Section title="when a thread is deleted" hint="archiving keeps everything.">
      <Card className="space-y-3 p-3">
        <Switch label="delete its transcript from honcho" description="deletes the transcript; the peer card may still reflect it until it regenerates." checked={settings.deleteOnDelete} disabled={busy !== null} onChange={(v) => set({ deleteOnDelete: v })} />
        <Switch label="also purge conclusions learned from it" description="removes derived conclusions that point at the deleted messages." checked={settings.purgeConclusionsOnDelete} disabled={busy !== null} onChange={(v) => set({ purgeConclusionsOnDelete: v })} />
        {error ? <p className="text-2xs text-destructive">{error}</p> : null}
      </Card>
    </Section>
  );
}

export function PrivacyTab() {
  const settings = useRemote("privacy.get", {});
  return (
    <div className="space-y-5">
      <Pauses />
      {settings.data === null ? (
        settings.error ? <Offline message={settings.error} onRetry={() => void settings.refetch()} /> : <Loading what="privacy settings" />
      ) : (
        <>
          <Rules settings={settings.data} onSaved={() => void settings.refetch()} />
          <TestBox />
          <Deletes settings={settings.data} onSaved={() => void settings.refetch()} />
        </>
      )}
    </div>
  );
}

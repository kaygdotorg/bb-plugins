import { useEffect, useRef, useState } from "react";
import type { PrivacySettings } from "../lib/contract";
import { useAction, useLabels, useMemoryRpc, useRemote } from "./data";
import { ago, lineErrors, type LineError } from "./format";
import { ThreadLink } from "./links";
import { Button, Card, Empty, Loading, Offline, Section, Switch, inputClass } from "./primitives";

const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

function Pauses() {
  const rpc = useMemoryRpc();
  const pauses = useRemote("pause.list", {});
  const labels = useLabels(
    (pauses.data ?? []).filter((p) => p.kind === "thread").map((p) => p.id),
    (pauses.data ?? []).filter((p) => p.kind === "project").map((p) => p.id),
  );
  const { busy, error, run } = useAction();
  return (
    <Section title="paused" hint="memory doesn't save paused chats or projects. whatever was saved earlier stays.">
      {pauses.data === null ? (
        pauses.error ? <Offline message={pauses.error} onRetry={() => void pauses.refetch()} /> : <Loading what="paused chats" />
      ) : pauses.data.length === 0 ? (
        <Empty title="nothing is paused" />
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card" aria-label="paused chats and projects">
          {pauses.data.map((p) => (
            <li key={`${p.kind}:${p.id}`} className="flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-b-0">
              <span className="w-14 shrink-0 text-2xs text-muted-foreground">{p.kind === "thread" ? "chat" : "project"}</span>
              {p.kind === "thread" ? (
                <span className="flex min-w-0 flex-1"><ThreadLink id={p.id} title={labels.thread(p.id)} /></span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-xs">{labels.project(p.id) ?? "unnamed project"}</span>
              )}
              <span className="shrink-0 text-2xs text-muted-foreground">paused {ago(p.since)}</span>
              <Button variant="ghost" className="h-6 px-1.5" title="start saving again" disabled={busy !== null} onClick={() => void run(p.id, async () => { await rpc.call("pause.set", { kind: p.kind, id: p.id, paused: false }); await pauses.refetch(); })}>resume</Button>
            </li>
          ))}
        </ul>
      )}
      {error ? <p className="text-2xs text-destructive">{error}</p> : null}
    </Section>
  );
}

type Field = "denyRemotes" | "denyPaths" | "patterns";
const FIELDS: Field[] = ["denyRemotes", "denyPaths", "patterns"];
const asText = (settings: PrivacySettings): Record<Field, string> => ({ denyRemotes: settings.denyRemotes.join("\n"), denyPaths: settings.denyPaths.join("\n"), patterns: settings.patterns.join("\n") });
const normal = (text: string) => JSON.stringify(lines(text));

/** Problems the server reported for one box, each beside the line it is about. */
function LineProblems({ text, errors }: { text: string; errors: LineError[] }) {
  if (errors.length === 0) return null;
  const entries = lines(text);
  // The server counts entries (blank lines dropped); the person counts lines in the box.
  const rawLines = text.split("\n").flatMap((l, i) => (l.trim() ? [i + 1] : []));
  return (
    <ul className="space-y-0.5" aria-label="problems">
      {errors.map((e) => (
        <li key={`${e.index ?? "all"}:${e.message}`} role="alert" className="flex gap-2 text-2xs text-destructive">
          {e.index === null ? null : <span className="shrink-0 font-mono">line {rawLines[e.index] ?? e.index + 1}</span>}
          <span className="min-w-0 flex-1 break-words">{e.index === null ? null : <span className="font-mono">{entries[e.index] ?? ""} </span>}{e.message}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The three rule boxes. The text lives in the textareas themselves (uncontrolled), so typing
 * never re-renders anything or calls the server; the only state is whether it differs from what
 * is saved, and it changes only when that flips. Save is the one call.
 */
function Rules({ settings, onSaved }: { settings: PrivacySettings; onSaved(): void }) {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const boxes = useRef<Record<Field, HTMLTextAreaElement | null>>({ denyRemotes: null, denyPaths: null, patterns: null });
  const saved = useRef(asText(settings));
  const [dirty, setDirty] = useState(false);
  const [justSaved, setJustSaved] = useState(false);
  const [problems, setProblems] = useState<LineError[]>([]);
  const [snapshot, setSnapshot] = useState(() => asText(settings)); // the text the problems refer to

  const read = (): Record<Field, string> => ({ denyRemotes: boxes.current.denyRemotes?.value ?? "", denyPaths: boxes.current.denyPaths?.value ?? "", patterns: boxes.current.patterns?.value ?? "" });
  const recompute = () => {
    const now = read();
    setDirty(FIELDS.some((f) => normal(now[f]) !== normal(saved.current[f])));
  };
  const write = (text: Record<Field, string>, only?: (f: Field) => boolean) => {
    for (const f of FIELDS) if (boxes.current[f] && (!only || only(f))) boxes.current[f]!.value = text[f];
  };

  // The stored value changed (our own save, or someone else's). Fields the user hasn't touched
  // follow it; a field with unsaved typing keeps the typing.
  const storedKey = JSON.stringify(asText(settings));
  useEffect(() => {
    const next = asText(settings);
    const before = saved.current;
    saved.current = next;
    write(next, (f) => normal(boxes.current[f]?.value ?? "") === normal(before[f]));
    recompute();
  }, [storedKey]);

  const box = (field: Field, label: string, hint: string, placeholder: string) => (
    <label className="block space-y-1">
      <span className="text-xs">{label}</span>
      <span className="block text-2xs text-muted-foreground">{hint}</span>
      <textarea
        aria-label={label}
        aria-invalid={problems.some((p) => p.field === field)}
        ref={(el) => { boxes.current[field] = el; }}
        className={`${inputClass} min-h-16 font-mono`}
        defaultValue={saved.current[field]}
        placeholder={placeholder}
        spellCheck={false}
        onChange={() => {
          setJustSaved(false);
          setProblems((old) => (old.some((p) => p.field === field) ? old.filter((p) => p.field !== field) : old));
          recompute();
        }}
      />
      <LineProblems text={snapshot[field]} errors={problems.filter((p) => p.field === field)} />
    </label>
  );

  const save = () => void run("save", async () => {
    const now = read();
    setSnapshot(now);
    setProblems([]);
    try {
      const result = await rpc.call("privacy.set", { denyRemotes: lines(now.denyRemotes), denyPaths: lines(now.denyPaths), patterns: lines(now.patterns) });
      // The server may tidy the lists (duplicates, spaces). What it returns is what is now saved.
      const stored = result && Array.isArray((result as PrivacySettings).patterns) ? asText(result as PrivacySettings) : now;
      saved.current = { ...saved.current, ...stored };
      // Only fields the user hasn't changed since pressing save take the tidied text.
      write(stored, (f) => normal(boxes.current[f]?.value ?? "") === normal(now[f]));
      recompute();
      setJustSaved(true);
      onSaved();
    } catch (e) {
      const found = lineErrors(e);
      setProblems(found);
      if (found.length === 0) throw e; // no line to blame: shows as the general message. the text stays.
      throw new Error(found.length === 1 ? "one entry needs fixing" : `${found.length} entries need fixing`);
    }
  });

  return (
    <Section title="never save or hide" hint="one entry per line.">
      <Card className="space-y-3 p-3">
        {box("denyRemotes", "skip these repositories", "chats in a repository with a matching git address are never saved. for example git@github.com:client/*", "git@github.com:client/*")}
        {box("denyPaths", "skip these folders", "chats in these folders are never saved. /work/client/** covers everything inside; a single * stays within one folder.", "/work/client/**")}
        {box("patterns", "hide text matching", "text that matches one of these patterns is replaced with [REDACTED] before anything is saved. patterns are regular expressions.", "")}
        <div className="flex items-center gap-2">
          <Button disabled={!dirty || busy !== null} onClick={save}>save</Button>
          {error ? <span role="alert" className="text-2xs text-destructive">{error}</span>
            : dirty ? <span className="text-2xs text-muted-foreground">unsaved changes</span>
            : justSaved ? <span role="status" className="text-2xs text-muted-foreground">saved</span> : null}
        </div>
      </Card>
    </Section>
  );
}

/** Runs only when the button is pressed; typing here is local. */
function TestBox() {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const box = useRef<HTMLTextAreaElement | null>(null);
  const [hasText, setHasText] = useState(false);
  const [result, setResult] = useState<{ text: string; count: number } | null>(null);
  return (
    <Section title="try it on some text" hint="paste text to see what would be hidden before saving. nothing is saved.">
      <Card className="space-y-2 p-3">
        <textarea
          ref={box}
          aria-label="text to try"
          className={`${inputClass} min-h-16 font-mono`}
          placeholder="paste something that might hold a password or key"
          spellCheck={false}
          onChange={(e) => { setHasText(e.target.value.length > 0); setResult((old) => (old === null ? old : null)); }}
        />
        <div className="flex items-center gap-2">
          <Button disabled={busy !== null || !hasText} onClick={() => void run("test", async () => setResult(await rpc.call("privacy.test", { text: box.current?.value ?? "" })))}>try it</Button>
          {result ? <span role="status" className="text-2xs text-muted-foreground">{result.count === 0 ? "nothing would be hidden" : `${result.count} would be hidden`}</span> : null}
          {error ? <span className="text-2xs text-destructive">{error}</span> : null}
        </div>
        {result ? <pre aria-label="text after hiding" className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted px-2 py-1.5 font-mono text-xs">{result.text}</pre> : null}
      </Card>
    </Section>
  );
}

function Deletes({ settings, onSaved }: { settings: PrivacySettings; onSaved(): void }) {
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const set = (patch: Partial<PrivacySettings>) => void run("toggle", async () => { await rpc.call("privacy.set", patch); onSaved(); });
  return (
    <Section title="when you delete a chat" hint="archiving a chat keeps everything.">
      <Card className="space-y-3 p-3">
        <Switch label="also delete its saved copy from memory" description="removes the saved conversation. the short profile memory keeps about you may still mention it until that profile refreshes." checked={settings.deleteOnDelete} disabled={busy !== null} onChange={(v) => set({ deleteOnDelete: v })} />
        <Switch label="also remove what memory learned from it" description="removes the things memory learned that came from the deleted messages." checked={settings.purgeConclusionsOnDelete} disabled={busy !== null} onChange={(v) => set({ purgeConclusionsOnDelete: v })} />
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

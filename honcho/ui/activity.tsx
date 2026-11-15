import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { ActivityEntry } from "../lib/contract";
import { clock, plural } from "./format";
import { useRemote } from "./data";
import { Badge, Button, Empty, Loading, Offline, StaleNote, cx, type Tone } from "./primitives";

const KIND_TONE: Record<ActivityEntry["kind"], Tone> = {
  upload: "good", recall: "neutral", tool: "neutral", delete: "warn", backfill: "neutral", harness: "neutral", failure: "bad",
};

function Row({ entry }: { entry: ActivityEntry }) {
  const nav = useBbNavigate();
  const meta = [
    entry.messages !== undefined ? plural(entry.messages, "message") : null,
    entry.redactions ? `${entry.redactions} redacted` : null,
  ].filter(Boolean);
  return (
    <li className="flex items-center gap-2 border-b border-border px-3 py-1.5 last:border-b-0">
      <time className="w-16 shrink-0 text-2xs tabular-nums text-muted-foreground" dateTime={new Date(entry.at).toISOString()}>{clock(entry.at)}</time>
      <span className="w-16 shrink-0"><Badge tone={KIND_TONE[entry.kind]}>{entry.kind}</Badge></span>
      <span className="min-w-0 flex-1">
        <span className={cx("block truncate text-xs", entry.kind === "failure" && "text-destructive")} title={entry.error ?? entry.summary}>{entry.summary}</span>
        {entry.error ? <span className="block truncate text-2xs text-muted-foreground">{entry.error}</span> : null}
      </span>
      {meta.length ? <span className="shrink-0 text-2xs text-muted-foreground">{meta.join(" · ")}</span> : null}
      {entry.reasoning ? <Badge title="reasoning content was included">reasoning</Badge> : null}
      {entry.threadId ? <Button variant="ghost" className="h-6 px-1.5" onClick={() => nav.toThread(entry.threadId!)} aria-label="open thread">thread</Button> : null}
    </li>
  );
}

export function ActivityTab() {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const feed = useRemote("activity.list", { limit: 100, ...(failuresOnly ? { kinds: ["failure" as const] } : {}) });
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-2xs text-muted-foreground">uploads, recalls, tool calls and deletes as they happen.</p>
        <Button variant={failuresOnly ? "outline" : "ghost"} aria-pressed={failuresOnly} onClick={() => setFailuresOnly(!failuresOnly)}>failures only</Button>
      </div>
      <StaleNote error={feed.data ? feed.error : null} />
      {feed.data === null ? (
        feed.error ? <Offline message={feed.error} onRetry={() => void feed.refetch()} /> : <Loading what="activity" />
      ) : feed.data.length === 0 ? (
        <Empty title={failuresOnly ? "no failures" : "nothing yet"}>{failuresOnly ? "uploads and recalls are working." : "activity shows up here once a thread is captured."}</Empty>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card" aria-label="activity">
          {feed.data.map((entry) => <Row key={entry.id} entry={entry} />)}
        </ul>
      )}
    </div>
  );
}

import { useState } from "react";
import type { ActivityEntry } from "../lib/contract";
import { clock, plainSummary, plural } from "./format";
import { useLabels, useRemote } from "./data";
import { ThreadLink } from "./links";
import { Badge, Button, Empty, Loading, Offline, StaleNote, cx, type Tone } from "./primitives";

const KIND_TONE: Record<ActivityEntry["kind"], Tone> = {
  upload: "good", recall: "neutral", tool: "neutral", delete: "warn", backfill: "neutral", harness: "neutral", failure: "bad",
};

const KIND_WORD: Record<ActivityEntry["kind"], string> = {
  upload: "saved", recall: "recalled", tool: "agent tool", delete: "deleted", backfill: "past chats", harness: "setup", failure: "problem",
};

function Row({ entry, title }: { entry: ActivityEntry; title: string | null }) {
  const meta = [
    entry.messages !== undefined ? plural(entry.messages, "message") : null,
    entry.redactions ? `${entry.redactions} hidden` : null,
  ].filter(Boolean);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-3 py-1.5 last:border-b-0">
      <time className="w-16 shrink-0 text-2xs tabular-nums text-muted-foreground" dateTime={new Date(entry.at).toISOString()}>{clock(entry.at)}</time>
      <span className="w-16 shrink-0"><Badge tone={KIND_TONE[entry.kind]}>{KIND_WORD[entry.kind]}</Badge></span>
      <span className="min-w-0 flex-[1_1_12rem]">
        <span className={cx("block truncate text-xs", entry.kind === "failure" && "text-destructive")} title={entry.error ?? plainSummary(entry.summary)}>{plainSummary(entry.summary)}</span>
        {entry.error ? <span className="block truncate text-2xs text-muted-foreground">{entry.error}</span> : null}
      </span>
      {meta.length ? <span className="shrink-0 text-2xs text-muted-foreground" title={entry.redactions ? "hidden means private details (like keys) were replaced before saving" : undefined}>{meta.join(" · ")}</span> : null}
      {entry.reasoning ? <Badge title="the assistant's thinking was saved too">with thinking</Badge> : null}
      {entry.threadId ? <span className="flex max-w-40 shrink-0"><ThreadLink id={entry.threadId} title={title} /></span> : null}
    </li>
  );
}

export function ActivityTab() {
  const [failuresOnly, setFailuresOnly] = useState(false);
  const feed = useRemote("activity.list", { limit: 100, ...(failuresOnly ? { kinds: ["failure" as const] } : {}) });
  const labels = useLabels((feed.data ?? []).flatMap((e) => (e.threadId ? [e.threadId] : [])));
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <p className="flex-1 text-2xs text-muted-foreground">what memory saved, looked up and deleted, as it happens.</p>
        <Button variant={failuresOnly ? "outline" : "ghost"} aria-pressed={failuresOnly} onClick={() => setFailuresOnly(!failuresOnly)}>show problems only</Button>
      </div>
      <StaleNote error={feed.data ? feed.error : null} />
      {feed.data === null ? (
        feed.error ? <Offline message={feed.error} onRetry={() => void feed.refetch()} /> : <Loading what="activity" />
      ) : feed.data.length === 0 ? (
        <Empty title={failuresOnly ? "no problems" : "nothing yet"}>{failuresOnly ? "saving and recall are working." : "this fills in once a chat is saved to memory."}</Empty>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border bg-card" aria-label="activity">
          {feed.data.map((entry) => <Row key={entry.id} entry={entry} title={entry.threadId ? labels.thread(entry.threadId) : null} />)}
        </ul>
      )}
    </div>
  );
}

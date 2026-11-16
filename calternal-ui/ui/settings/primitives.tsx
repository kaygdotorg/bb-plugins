// Shared building blocks of the settings screen: layout (Section, SubHeading, Row), class strings, and the save helper.
import { useState } from "react";
import type { useRpc } from "@get-bb/plugin-sdk/app";
import type { FramePrefsPatch, FrameState, rpcContract } from "../../shared/contract";

export type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
export type Commit = (next: FrameState) => void;

export const inputCls =
  "h-8 min-w-0 rounded-md border border-border bg-muted px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
export const buttonCls =
  "inline-flex h-8 shrink-0 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm hover:bg-accent disabled:opacity-50";
export const linkButtonCls =
  "text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50 disabled:no-underline";
export const linkCls = "underline underline-offset-2 hover:text-foreground";
/** The label column shared by every Row and font row, so controls line up down a section. */
export const LABEL_COL = "7rem";

export const messageOf = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

export function Spinner() {
  return <span aria-hidden="true" className="inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

export function ErrorLine({ message }: { message: string | null }) {
  return message ? <p role="alert" className="text-xs text-destructive">{message}</p> : null;
}

/**
 * A top-level section, grouped like bb's own Settings: a title, the content in one card (bb's card classes, so
 * desktop matches bb's sections; css.ts gives it iOS's grouped-list shape on phones), and the hint. On phones the
 * hint moves under the card, where iOS puts explanations (css.ts `[data-cf-section-note]`).
 */
export function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div data-cf-section-head="" className="flex flex-col gap-1">
        <h3 data-cf-section-title="" className="text-sm font-semibold">{title}</h3>
      </div>
      {hint ? <p data-cf-section-note="" className="text-xs text-muted-foreground" style={{ marginTop: -8 }}>{hint}</p> : null}
      <div data-cf-group="" className="flex flex-col gap-4 rounded-lg border border-border bg-card px-4 py-3.5">{children}</div>
    </section>
  );
}

/** A heading inside a section, with an optional trailing action (e.g. Reset). */
export function SubHeading({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex min-h-6 items-center justify-between gap-2">
      <h4 className="text-xs font-medium">
        {title}
        {hint ? <span className="font-normal text-muted-foreground"> · {hint}</span> : null}
      </h4>
      {action}
    </div>
  );
}

/** Label column plus control column. */
export function Row({ label, htmlFor, children }: { label: React.ReactNode; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div data-cf-row="" className="grid min-h-8 items-center gap-x-4" style={{ gridTemplateColumns: `${LABEL_COL} minmax(0, 1fr)` }}>
      <label htmlFor={htmlFor} className="text-sm">{label}</label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

/** Saves a prefs patch and commits the result; exposes the last error. Resolves true on success. */
export function useSave(rpc: Rpc, commit: Commit) {
  const [error, setError] = useState<string | null>(null);
  const save = async (patch: FramePrefsPatch): Promise<boolean> => {
    setError(null);
    try {
      commit(await rpc.call("frame_set", patch));
      return true;
    } catch (e) {
      setError(messageOf(e, "Could not save."));
      return false;
    }
  };
  return { error, save };
}

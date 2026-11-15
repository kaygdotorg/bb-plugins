import type { ButtonHTMLAttributes, ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function Button({ variant = "outline", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "outline" | "ghost" | "danger" }) {
  return (
    <button
      type="button"
      {...props}
      className={cx(
        "inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
        variant === "outline" && "border border-border bg-background text-foreground hover:bg-muted",
        variant === "ghost" && "text-muted-foreground hover:bg-muted hover:text-foreground",
        variant === "danger" && "border border-border text-destructive hover:bg-destructive/10",
        className,
      )}
    />
  );
}

export type Tone = "neutral" | "good" | "warn" | "bad";
export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-2xs leading-none",
        tone === "neutral" && "bg-muted text-muted-foreground",
        tone === "good" && "bg-primary/15 text-primary",
        tone === "warn" && "bg-warning/15 text-warning",
        tone === "bad" && "bg-destructive/15 text-destructive",
      )}
    >
      {children}
    </span>
  );
}

export function Section({ title, hint, actions, children }: { title: string; hint?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <header className="flex items-baseline gap-2">
        <h2 className="text-xs font-semibold">{title}</h2>
        {hint ? <p className="min-w-0 flex-1 text-2xs text-muted-foreground">{hint}</p> : <span className="flex-1" />}
        {actions}
      </header>
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-border bg-card text-card-foreground", className)}>{children}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div role="status" className="rounded-lg border border-dashed border-border px-3 py-6 text-center">
      <p className="text-xs font-medium">{title}</p>
      {children ? <p className="mt-1 text-xs text-muted-foreground">{children}</p> : null}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <p role="status" className="py-6 text-center text-xs text-muted-foreground">loading {what}…</p>;
}

/** Shown when the first fetch failed. Stale data keeps its own marker. */
export function Offline({ message, onRetry }: { message: string; onRetry(): void }) {
  return (
    <div role="alert" className="flex items-center gap-2 rounded-lg border border-dashed border-border px-3 py-3">
      <Icon name="CloudOff" aria-hidden="true" className="size-3.5 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">can't reach memory right now. {message}</p>
      <Button variant="ghost" onClick={onRetry}>try again</Button>
    </div>
  );
}

export function StaleNote({ error }: { error: string | null }) {
  return error ? <p className="text-2xs text-warning">can't reach memory, showing the last result</p> : null;
}

export function Switch({ checked, onChange, label, description, disabled }: { checked: boolean; onChange(next: boolean): void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx("mt-0.5 inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-border p-0.5 transition-colors disabled:opacity-50", checked ? "bg-primary" : "bg-muted")}
      >
        <span className={cx("size-3 rounded-full bg-background transition-transform", checked && "translate-x-3")} />
      </button>
      <span className="min-w-0">
        <span className="block text-xs">{label}</span>
        {description ? <span className="block text-2xs text-muted-foreground">{description}</span> : null}
      </span>
    </label>
  );
}

export const inputClass = "w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.min(100, Math.round((value / max) * 100)) : 0;
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-3 py-1">
      <dt className="w-24 shrink-0 text-2xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 truncate text-xs">{children}</dd>
    </div>
  );
}

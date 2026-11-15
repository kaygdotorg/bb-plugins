// Usage section: toggles for the pooled Claude/Codex percentages in bb's sidebar footer.
import { useId } from "react";
import type { FrameState, UsagePrefs } from "../../shared/contract";
import { ErrorLine, Row, Section, useSave, type Commit, type Rpc } from "./primitives";

const WINDOWS: { value: UsagePrefs["window"]; label: string }[] = [
  { value: "auto", label: "Auto" },
  { value: "session", label: "5-hour session" },
  { value: "weekly", label: "Weekly" },
];

export function UsageSection({ state, rpc, commit }: { state: FrameState; rpc: Rpc; commit: Commit }) {
  const { error, save } = useSave(rpc, commit);
  const baseId = useId();
  const usage = state.usage;
  const set = (patch: Partial<UsagePrefs>) => void save({ usage: patch });

  const toggle = (key: "enabled" | "showIcons", label: string, description: string) => (
    <Row label={label} htmlFor={`${baseId}-${key}`}>
      <label className={`flex cursor-pointer items-center gap-2 text-sm text-muted-foreground ${key !== "enabled" && !usage.enabled ? "opacity-50" : ""}`}>
        <input
          id={`${baseId}-${key}`}
          type="checkbox"
          checked={usage[key]}
          disabled={key !== "enabled" && !usage.enabled}
          onChange={(e) => set({ [key]: e.target.checked })}
        />
        {description}
      </label>
    </Row>
  );

  return (
    <Section title="Usage" hint="Pooled Claude and Codex quota, as percentages in the sidebar footer. Data comes from the CLIProxyAPI Usage plugin.">
      <div className="flex flex-col gap-2">
        {toggle("enabled", "Show usage", "Show pooled usage in the footer")}
        {toggle("showIcons", "Provider icons", "Show provider icons instead of names")}
        <Row label="Window">
          <div role="radiogroup" aria-label="Usage window" className={`inline-flex rounded-md border border-border bg-muted p-0.5 ${usage.enabled ? "" : "opacity-50"}`}>
            {WINDOWS.map((w) => {
              const selected = usage.window === w.value;
              return (
                <button
                  key={w.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!usage.enabled}
                  onClick={() => { if (!selected) set({ window: w.value }); }}
                  className={`h-7 rounded-md px-3 text-sm ${selected ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {w.label}
                </button>
              );
            })}
          </div>
        </Row>
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}

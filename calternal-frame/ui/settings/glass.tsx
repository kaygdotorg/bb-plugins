// Glass section: blur / tint / dim for the sidebars and the chat card, as two aligned groups.
import { useEffect, useId, useRef, useState } from "react";
import type { FrameState, SurfacePrefs } from "../../shared/contract";
import { DEFAULT_PREFS } from "../../shared/defaults";
import { ErrorLine, inputCls, linkButtonCls, Section, SubHeading, useSave, type Commit, type Rpc } from "./primitives";

const EFFECTS = [
  { key: "blur", label: "Blur", unit: "px", max: 120 },
  { key: "tint", label: "Tint", unit: "%", max: 100 },
  { key: "dim", label: "Dim", unit: "%", max: 100 },
] as const;

const GROUPS = [
  { key: "sidebar", title: "Sidebars", hint: "left sidebar and right panel" },
  { key: "chat", title: "Chat card", hint: "the card around the conversation" },
] as const;

/** Checkbox + number + unit. Typing saves after a short pause; the checkbox saves at once. */
function EffectRow({
  id, label, unit, max, effect, onSave,
}: {
  id: string; label: string; unit: string; max: number;
  effect: { on: boolean; value: number };
  onSave: (effect: { on: boolean; value: number }) => void;
}) {
  const [text, setText] = useState(String(effect.value));
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The debounced callback must see the latest checkbox state, not the one from when typing began.
  const latest = useRef(effect);
  latest.current = effect;

  useEffect(() => setText(String(effect.value)), [effect.value]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const change = (raw: string) => {
    setText(raw);
    clearTimeout(timer.current);
    const n = Number(raw);
    if (raw.trim() === "" || !Number.isFinite(n)) return;
    timer.current = setTimeout(() => {
      const value = Math.min(max, Math.max(0, Math.round(n)));
      if (value !== latest.current.value) onSave({ on: latest.current.on, value });
    }, 300);
  };

  return (
    <div className="grid h-8 grid-cols-[5rem_4rem_1rem] items-center gap-x-2">
      <label htmlFor={`${id}-on`} className="flex cursor-pointer items-center gap-2 text-sm">
        <input
          id={`${id}-on`}
          type="checkbox"
          checked={effect.on}
          onChange={(e) => {
            clearTimeout(timer.current);
            onSave({ on: e.target.checked, value: effect.value });
          }}
        />
        {label}
      </label>
      <input
        type="number"
        min={0}
        max={max}
        aria-label={`${label} amount in ${unit}`}
        disabled={!effect.on}
        value={text}
        onChange={(e) => change(e.target.value)}
        className={`${inputCls} w-16 px-2`}
      />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </div>
  );
}

export function GlassSection({ state, rpc, commit }: { state: FrameState; rpc: Rpc; commit: Commit }) {
  const { error, save } = useSave(rpc, commit);
  const baseId = useId();

  return (
    <Section title="Glass" hint="How much of the wallpaper shows through, and how soft it looks.">
      <div className="grid grid-cols-1 gap-x-8 gap-y-6 md:grid-cols-2">
        {GROUPS.map((group) => (
          <div key={group.key} className="flex flex-col gap-2">
            <SubHeading
              title={group.title}
              hint={group.hint}
              action={
                <button type="button" className={linkButtonCls} onClick={() => void save({ [group.key]: DEFAULT_PREFS[group.key] })}>
                  Reset
                </button>
              }
            />
            <div className="flex flex-col gap-1">
              {EFFECTS.map((fx) => (
                <EffectRow
                  key={fx.key}
                  id={`${baseId}-${group.key}-${fx.key}`}
                  label={fx.label}
                  unit={fx.unit}
                  max={fx.max}
                  effect={state[group.key][fx.key]}
                  onSave={(effect) => void save({ [group.key]: { [fx.key]: effect } satisfies Partial<SurfacePrefs> })}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}

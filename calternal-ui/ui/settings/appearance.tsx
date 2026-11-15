// "Colour & size" section: the accent colour bb follows and the interface size slider.
import { useEffect, useId, useState } from "react";
import type { FrameState } from "../../shared/contract";
import { setUiScale } from "../../frame/prefs";
import { ErrorLine, linkButtonCls, Row, Section, useSave, type Commit, type Rpc } from "./primitives";

const ACCENT_SWATCHES = [
  { color: "#d9925b", name: "Amber" },
  { color: "#e07a6a", name: "Coral" },
  { color: "#d47aa3", name: "Rose" },
  { color: "#9d86e0", name: "Violet" },
  { color: "#6f9be8", name: "Blue" },
  { color: "#4fb3a9", name: "Teal" },
  { color: "#7cb46b", name: "Green" },
  { color: "#c8b27a", name: "Sand" },
];

export function AppearanceSection({ state, rpc, commit }: { state: FrameState; rpc: Rpc; commit: Commit }) {
  const { error, save } = useSave(rpc, commit);
  const [draft, setDraft] = useState(state.uiScale);
  const sizeId = useId();
  const accent = state.accent;
  const fromWallpaper = accent.mode === "wallpaper";

  useEffect(() => setDraft(state.uiScale), [state.uiScale]);

  const saveScale = async (value: number) => {
    if (value === state.uiScale) return;
    // Revert the live preview if the save fails.
    if (!(await save({ uiScale: value }))) setUiScale(state.uiScale);
  };

  return (
    <Section title="Colour & size" hint="The accent bb's buttons and focus rings follow, and the scale of text and controls. bb keeps lightness so text stays readable.">
      <div className="flex flex-col gap-2">
        <Row label="Accent">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name="cf-accent-mode" checked={fromWallpaper} onChange={() => void save({ accent: { ...accent, mode: "wallpaper" } })} />
            From wallpaper
          </label>
          <label className="ml-2 flex cursor-pointer items-center gap-2 text-sm">
            <input type="radio" name="cf-accent-mode" checked={!fromWallpaper} onChange={() => void save({ accent: { ...accent, mode: "custom" } })} />
            Custom
          </label>
          <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            <span aria-hidden="true" className="inline-block size-4 rounded-full border border-border bg-primary" />
            Current
          </span>
        </Row>
        <Row label={<span className={fromWallpaper ? "text-muted-foreground" : ""}>Colour</span>}>
          <div className={`flex flex-wrap items-center gap-2 ${fromWallpaper ? "opacity-50" : ""}`}>
            {ACCENT_SWATCHES.map((s) => {
              const selected = !fromWallpaper && accent.color.toLowerCase() === s.color;
              return (
                <button
                  key={s.color}
                  type="button"
                  title={s.name}
                  aria-label={s.name}
                  aria-pressed={selected}
                  disabled={fromWallpaper}
                  onClick={() => void save({ accent: { mode: "custom", color: s.color } })}
                  className={`size-6 rounded-full border border-border transition-transform hover:scale-110 disabled:hover:scale-100 ${selected ? "ring-2 ring-ring ring-offset-2 ring-offset-transparent" : ""}`}
                  style={{ backgroundColor: s.color }}
                />
              );
            })}
            <label className="ml-1 flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="color"
                value={accent.color}
                disabled={fromWallpaper}
                className="h-6 w-8 cursor-pointer rounded-md border border-border bg-transparent p-0 disabled:cursor-default"
                onChange={(e) => void save({ accent: { mode: "custom", color: e.target.value } })}
              />
              Pick
            </label>
          </div>
        </Row>
        <Row label="Interface size" htmlFor={sizeId}>
          <span className="text-xs text-muted-foreground">A</span>
          <input
            id={sizeId}
            type="range"
            min={75}
            max={150}
            step={5}
            value={draft}
            className="min-w-0 flex-1 accent-primary"
            // Preview live while dragging; save once on release.
            onChange={(e) => { const v = Number(e.target.value); setDraft(v); setUiScale(v); }}
            onPointerUp={() => void saveScale(draft)}
            onKeyUp={() => void saveScale(draft)}
            onBlur={() => void saveScale(draft)}
          />
          <span className="text-base text-muted-foreground">A</span>
          <span className="w-12 text-right text-sm tabular-nums">{draft}%</span>
          <button
            type="button"
            className={linkButtonCls}
            disabled={draft === 100}
            onClick={() => { setDraft(100); setUiScale(100); void saveScale(100); }}
          >
            Reset
          </button>
        </Row>
        <Row label="Chat layout">
          {([["wide", "Wide"], ["centered", "Centred"]] as const).map(([value, text]) => (
            <label key={value} className="mr-2 flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="cf-chat-width" checked={state.chatWidth === value} onChange={() => void save({ chatWidth: value })} />
              {text}
            </label>
          ))}
        </Row>
        <Row label="Clock">
          {([["24h", "24-hour"], ["12h", "12-hour"], ["system", "Browser default"]] as const).map(([value, text]) => (
            <label key={value} className="mr-2 flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="cf-clock" checked={state.clock === value} onChange={() => void save({ clock: value })} />
              {text}
            </label>
          ))}
        </Row>
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}

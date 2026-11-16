// Wordmark section: the text at the top of the sidebar and its font (any catalogue font or upload).
import { useEffect, useId, useState } from "react";
import type { FrameState } from "../../shared/contract";
import { loadGoogleFontPreview } from "../../frame/font-preview";
import { FontPicker, useFontCatalog } from "./fonts";
import { ErrorLine, inputCls, Row, Section, Spinner, useSave, type Commit, type Rpc } from "./primitives";

/** Script faces that read well as a short wordmark, shown as one-click previews under "Try". */
const SUGGESTED = [
  // Flowing scripts
  "Dancing Script", "Sacramento", "Great Vibes", "Allura", "Parisienne", "Alex Brush",
  // Casual and bold
  "Pacifico", "Satisfy", "Kaushan Script", "Yellowtail", "Cookie", "Damion",
  // Handwritten
  "Caveat", "Homemade Apple", "Nothing You Could Do", "Marck Script",
];

export function BrandSection({ state, rpc, commit }: { state: FrameState; rpc: Rpc; commit: Commit }) {
  const { error, save } = useSave(rpc, commit);
  const [text, setText] = useState(state.brand.text);
  const { fonts, error: loadError } = useFontCatalog(rpc);
  const id = useId();

  useEffect(() => setText(state.brand.text), [state.brand.text]);

  // Previews of the suggested scripts (settings only; the chosen one is installed locally).
  useEffect(() => SUGGESTED.forEach(loadGoogleFontPreview), []);

  const commitText = () => { if (text !== state.brand.text) void save({ brand: { text } }); };

  return (
    <Section title="Wordmark" hint="The name at the top of the sidebar, in any font from the lists (Google, Fontsource, Fontshare or your own). Leave it empty to hide it.">
      <div className="flex flex-col gap-2">
        <Row label="Text" htmlFor={`${id}-text`}>
          <input
            id={`${id}-text`}
            className={`${inputCls} w-48`}
            value={text}
            maxLength={40}
            placeholder="bb"
            onChange={(e) => setText(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => { if (e.key === "Enter") commitText(); }}
          />
        </Row>
        <Row label="Font" htmlFor={`${id}-font`}>
          {fonts ? (
            <FontPicker id={`${id}-font`} fonts={fonts} value={state.brand.font} mono={false} disabled={false} onPick={(font) => void save({ brand: { font } })} />
          ) : (
            <span className="flex h-8 items-center gap-2 text-xs text-muted-foreground">{loadError ?? <><Spinner /> Loading fonts</>}</span>
          )}
        </Row>
        <Row label="Try">
          <div className="flex flex-wrap gap-2">
            {SUGGESTED.map((family) => (
              <button
                key={family}
                type="button"
                aria-pressed={state.brand.font === family}
                onClick={() => void save({ brand: { font: family } })}
                className={`h-8 rounded-md border px-3 text-base ${state.brand.font === family ? "border-transparent bg-accent" : "border-border hover:bg-accent/60"}`}
                style={{ fontFamily: `"${family}", cursive` }}
                title={family}
              >
                {(state.brand.text || "bb").slice(0, 12)}
              </button>
            ))}
          </div>
        </Row>
      </div>
      <ErrorLine message={error} />
    </Section>
  );
}

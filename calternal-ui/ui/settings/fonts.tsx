// Fonts section: per-surface font overrides, each a checkbox + searchable picker + live sample.
// Sources (2026-11-16): Google Fonts, Fontsource's extras, Fontshare, your uploads, and the system font.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CatalogFont, FrameState } from "../../shared/contract";
import { SOURCE_LABEL, SYSTEM_FONT, systemStack } from "../../shared/fonts";
import { loadFontPreview } from "../../frame/font-preview";
import { FontUpload } from "./font-upload";
import { ErrorLine, inputCls, LABEL_COL, messageOf, Section, Spinner, useSave, type Commit, type Rpc } from "./primitives";

type FontKey = keyof FrameState["fonts"];

const FONT_ROWS: { key: FontKey; label: string; note?: string; mono?: boolean }[] = [
  { key: "ui", label: "Interface" },
  { key: "chat", label: "Chat", note: "Also applies to the composer." },
  { key: "code", label: "Code", mono: true },
  { key: "terminal", label: "Terminal", note: "Applies to newly opened terminals.", mono: true },
];
const SAMPLE = "The quick brown fox \u2014 0123 {}";
const MAX_MATCHES = 40;

/** The device's own font, first in the text and code pickers. SF Pro can't be downloaded (Apple's licence). */
const systemEntry = (mono: boolean): CatalogFont =>
  ({ family: SYSTEM_FONT, category: mono ? "SF Mono on Apple" : "SF Pro on Apple", source: "system" });

/** Short categories for the list's right column: "Mono · Fontsource". */
const SHORT: Record<string, string> = { Monospace: "Mono", "Sans Serif": "Sans", Handwriting: "Script" };
const detail = (f: CatalogFont) => (f.source === "system" || f.source === "upload" ? f.category : `${SHORT[f.category] ?? f.category} · ${SOURCE_LABEL[f.source]}`);

/** Loads the font list once per Settings section. */
export function useFontCatalog(rpc: Rpc) {
  const [fonts, setFonts] = useState<CatalogFont[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    rpc.call("font_catalog", {}).then(
      (list) => { if (!cancelled) setFonts(list); },
      (e: unknown) => { if (!cancelled) setError(messageOf(e, "Could not load the font list.")); },
    );
    return () => { cancelled = true; };
  }, [rpc, version]);
  return { fonts, error, reload: () => setVersion((v) => v + 1) };
}

export function FontPicker({
  id, fonts, value, mono, disabled, onPick,
}: {
  id: string; fonts: CatalogFont[]; value: string; mono: boolean; disabled: boolean; onPick: (family: string) => void;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [typed, setTyped] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Where the list floats (viewport coords, under the field). It is portalled to <body>: inside the Settings
   *  page its glass had nothing to blur, since the page's scroller carries a mask (the top fade) and WebKit and
   *  Chrome don't run a backdrop-filter through a masked ancestor (kayg's phone: the rows below read straight
   *  through the list). Every other menu in bb is portalled the same way. */
  const [at, setAt] = useState<{ left: number; top: number; width: number; maxH: number } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = root.current?.querySelector("input")?.getBoundingClientRect();
      if (!r) return;
      const vv = window.visualViewport;
      const bottom = vv ? vv.offsetTop + vv.height : innerHeight;
      setAt({ left: r.left, top: r.bottom + 4, width: r.width, maxH: Math.max(120, Math.min(224, bottom - r.bottom - 12)) });
    };
    place();
    window.addEventListener("scroll", place, { capture: true, passive: true });
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, { capture: true });
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
    };
  }, [open]);

  useEffect(() => setQuery(value), [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (root.current && !root.current.contains(target) && !listRef.current?.contains(target)) {
        setOpen(false);
        setQuery(value);
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, value]);

  const matches = useMemo(() => {
    const q = typed ? query.trim().toLowerCase() : "";
    // Family names first; typing a source ("fontshare") then lists that source's families.
    let list = q
      ? [...fonts.filter((f) => f.family.toLowerCase().includes(q)),
        ...fonts.filter((f) => !f.family.toLowerCase().includes(q) && q.length >= 4 && SOURCE_LABEL[f.source].toLowerCase().startsWith(q))]
      : fonts;
    if (mono) {
      const isMono = (f: CatalogFont) => f.source === "system" || f.category === "Monospace";
      list = [...list.filter(isMono), ...list.filter((f) => !isMono(f))];
    }
    return list.slice(0, MAX_MATCHES);
  }, [fonts, query, typed, mono]);

  useEffect(() => {
    listRef.current?.children[index]?.scrollIntoView({ block: "nearest" });
  }, [index, open]);

  const close = () => { setOpen(false); setTyped(false); setQuery(value); };
  const pick = (family: string) => { setOpen(false); setTyped(false); setQuery(family); if (family !== value) onPick(family); };
  const optionId = (i: number) => `${id}-opt-${i}`;

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      const step = e.key === "ArrowDown" ? 1 : -1;
      setIndex((i) => Math.min(matches.length - 1, Math.max(0, i + step)));
    } else if (e.key === "Enter" && open) {
      e.preventDefault();
      const match = matches[index];
      if (match) pick(match.family);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Tab") {
      close();
    }
  };

  return (
    <div ref={root} className="relative min-w-0 flex-1">
      <input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[index] ? optionId(index) : undefined}
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        className={`${inputCls} w-full`}
        value={query}
        placeholder="Search fonts"
        onFocus={(e) => { setOpen(true); e.currentTarget.select(); }}
        onClick={() => setOpen(true)}
        onChange={(e) => { setQuery(e.target.value); setTyped(true); setIndex(0); setOpen(true); }}
        onKeyDown={onKeyDown}
      />
      {open && at ? createPortal(
        <ul
          ref={listRef}
          id={`${id}-list`}
          role="listbox"
          data-cf-font-list=""
          style={{ position: "fixed", left: at.left, top: at.top, width: at.width, maxHeight: at.maxH }}
          className="z-50 overflow-auto rounded-md border border-border bg-popover text-popover-foreground py-1 shadow-md"
        >
          {matches.length === 0 ? (
            <li className="px-2 py-1 text-xs text-muted-foreground">No matching fonts</li>
          ) : matches.map((f, i) => (
            <li
              key={f.family}
              id={optionId(i)}
              role="option"
              aria-selected={f.family === value}
              onMouseEnter={() => setIndex(i)}
              onMouseDown={(e) => { e.preventDefault(); pick(f.family); }}
              className={`flex cursor-pointer items-center justify-between gap-2 px-2 py-1 text-sm ${i === index ? "bg-accent" : ""}`}
            >
              <span className="truncate">{f.family}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{detail(f)}</span>
            </li>
          ))}
        </ul>,
        document.body,
      ) : null}
    </div>
  );
}

function FontSample({ family, font, mono }: { family: string; font: CatalogFont | undefined; mono: boolean }) {
  const system = family === SYSTEM_FONT;
  useEffect(() => { if (family && !system) loadFontPreview(font, family); }, [family, font, system]);
  return (
    <p
      className="truncate text-sm text-muted-foreground"
      style={{ fontFamily: system ? systemStack(mono) : `"${family.replace(/["\\]/g, "")}", ${mono ? "monospace" : "sans-serif"}` }}
    >
      {SAMPLE}
    </p>
  );
}

export function FontsSection({ state, rpc, commit }: { state: FrameState; rpc: Rpc; commit: Commit }) {
  const { fonts: catalog, error: loadError, reload } = useFontCatalog(rpc);
  const { error, save: savePatch } = useSave(rpc, commit);
  const baseId = useId();
  const withSystem = useMemo(() => catalog && {
    text: [systemEntry(false), ...catalog],
    mono: [systemEntry(true), ...catalog],
  }, [catalog]);
  const byFamily = useMemo(() => new Map((catalog ?? []).map((f) => [f.family, f])), [catalog]);

  const save = (key: FontKey, font: { on: boolean; family: string }) => void savePatch({ fonts: { [key]: font } });

  return (
    <Section title="Fonts" hint="Override bb's fonts with a font from Google Fonts, Fontsource or Fontshare, your own font file, or your device's (SF Pro on Apple). Chosen fonts are stored on the bb server.">
      <ErrorLine message={loadError} />
      <div className="flex flex-col gap-4">
        {FONT_ROWS.map((row) => {
          const font = state.fonts[row.key];
          const id = `${baseId}-${row.key}`;
          return (
            <div key={row.key} data-cf-row="" className="grid items-center gap-x-4 gap-y-1" style={{ gridTemplateColumns: `${LABEL_COL} minmax(0, 1fr)` }}>
              <label htmlFor={`${id}-on`} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  id={`${id}-on`}
                  type="checkbox"
                  checked={font.on}
                  onChange={(e) => save(row.key, { on: e.target.checked, family: font.family })}
                />
                {row.label}
              </label>
              <label className="sr-only" htmlFor={id}>{row.label} font family</label>
              {withSystem ? (
                <FontPicker
                  id={id}
                  fonts={row.mono ? withSystem.mono : withSystem.text}
                  value={font.family}
                  mono={row.mono === true}
                  disabled={!font.on}
                  onPick={(family) => save(row.key, { on: font.on, family })}
                />
              ) : (
                <div className="flex h-8 flex-1 items-center gap-2 text-xs text-muted-foreground" aria-busy={!loadError}>
                  {loadError ? font.family : <><Spinner /> Loading fonts</>}
                </div>
              )}
              <div className="col-start-2 min-w-0">
                <FontSample family={font.family} font={byFamily.get(font.family)} mono={row.mono === true} />
                {row.note ? <p className="text-xs text-muted-foreground">{row.note}</p> : null}
              </div>
            </div>
          );
        })}
      </div>
      <FontUpload rpc={rpc} onAdded={reload} />
      <ErrorLine message={error} />
    </Section>
  );
}

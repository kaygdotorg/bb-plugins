// Fonts → "Add your own font": upload font files you own (added 2026-11-16) for families no catalogue has,
// e.g. SF Pro from developer.apple.com for your own devices, or Obel Mono. Files go to the bb server
// (font_upload), which stores them like any other installed font; then they show in every picker.
import { useId, useState } from "react";
import { buttonCls, ErrorLine, inputCls, linkButtonCls, messageOf, Spinner, type Rpc } from "./primitives";

/** Mirrors MAX_FONT_UPLOAD_CHARS in shared/contract.ts (the app imports no values from there). */
const MAX_CHARS = 12_000_000;
const STYLE_WORDS = /^(thin|hairline|extra|ultra|light|regular|normal|book|roman|medium|semi|demi|bold|black|heavy|italic|oblique|variable|vf|\d00|extralight|ultralight|semibold|demibold|extrabold|ultrabold)$/i;

/** "SF-Pro-Text-SemiboldItalic.otf" → "SF Pro Text": a first guess at the family; you can edit it. */
export function guessFamily(fileName: string): string {
  const words = fileName
    .replace(/\.[^.]+$/, "")
    .split(/[-_ ]+/)
    .flatMap((w) => w.split(/(?<=[a-z])(?=(?:Semi|Demi|Extra|Ultra)?(?:Bold|Light|Italic|Regular|Medium|Black|Thin|Heavy))/));
  const kept = words.filter((w) => w && !STYLE_WORDS.test(w));
  return (kept.join(" ") || "My font").replace(/[^\p{L}\p{N} ._-]/gu, "").slice(0, 60).trim();
}

const readDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error ?? new Error("Could not read the file."));
  reader.readAsDataURL(file);
});

export function FontUpload({ rpc, onAdded }: { rpc: Rpc; onAdded: (family: string) => void }) {
  const [files, setFiles] = useState<File[] | null>(null);
  const [family, setFamily] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const id = useId();

  const upload = async () => {
    if (!files) return;
    setBusy(true);
    setError(null);
    try {
      let name = family.trim();
      // One file per call: each is one weight or style, and stays under the RPC size cap.
      for (const file of files) {
        const dataUrl = await readDataUrl(file);
        if (dataUrl.length > MAX_CHARS) throw new Error(`${file.name} is too large (8 MB at most). A .woff2 is about a third of the size.`);
        name = (await rpc.call("font_upload", { family: name, fileName: file.name, dataUrl })).family;
      }
      setDone(`Added ${name} (${files.length} file${files.length > 1 ? "s" : ""}). Pick it in any font list above.`);
      setFiles(null);
      onAdded(name);
    } catch (e) {
      setError(messageOf(e, "Could not upload the font."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <label className={`${linkButtonCls} cursor-pointer`}>
          Add your own font…
          <input
            type="file"
            multiple
            accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf"
            className="sr-only"
            disabled={busy}
            onChange={(e) => {
              const picked = [...(e.target.files ?? [])];
              e.target.value = "";
              if (!picked.length) return;
              setFiles(picked);
              setFamily(guessFamily(picked[0]!.name));
              setDone(null);
              setError(null);
            }}
          />
        </label>
        <span className="text-xs text-muted-foreground">
          .woff2, .woff, .ttf or .otf you own, e.g. SF Pro. Weights and italics come from the file names.
        </span>
      </div>
      {files ? (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-family`} className="text-sm">Family name</label>
          <input id={`${id}-family`} className={`${inputCls} w-48`} value={family} maxLength={60}
            onChange={(e) => setFamily(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void upload(); }} />
          <button type="button" className={buttonCls} disabled={busy || !family.trim()} aria-busy={busy} onClick={() => void upload()}>
            {busy ? <Spinner /> : null} Upload {files.length} file{files.length > 1 ? "s" : ""}
          </button>
          <button type="button" className={linkButtonCls} disabled={busy} onClick={() => setFiles(null)}>Cancel</button>
        </div>
      ) : null}
      {done ? <p className="text-xs text-muted-foreground">{done}</p> : null}
      <ErrorLine message={error} />
    </div>
  );
}

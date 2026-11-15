// Regenerates lib/harness/hook-assets.ts from hooks/. Run from anywhere:
//   node test/harness/gen-assets.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../", import.meta.url);
export function render() {
  const sh = readFileSync(new URL("hooks/bb-honcho-hook.sh", root), "utf8");
  const mjs = readFileSync(new URL("hooks/bb-honcho-hook.mjs", root), "utf8");
  return [
    "// GENERATED from hooks/bb-honcho-hook.{sh,mjs}; test/harness/assets.test.ts checks it.",
    "// The host artifact is a single bundle, so the hook ships inside it as strings.",
    "// Regenerate: node test/harness/gen-assets.mjs",
    `export const HOOK_SH = ${JSON.stringify(sh)};`,
    `export const HOOK_MJS = ${JSON.stringify(mjs)};`,
    "",
  ].join("\n");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  writeFileSync(new URL("lib/harness/hook-assets.ts", root), render());
}

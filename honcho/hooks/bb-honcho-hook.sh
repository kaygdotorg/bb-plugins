#!/bin/sh
# bb-honcho hook guard. Installed globally into Claude Code and Codex by bb's
# honcho plugin; it does nothing unless bb started the harness (BB_HONCHO=1),
# so CLI sessions outside bb never pay for a node start.
[ "${BB_HONCHO:-}" = "1" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
bb_honcho_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || exit 0
[ -f "$bb_honcho_dir/bb-honcho-hook.mjs" ] || exit 0
if [ "${BB_HONCHO_HOOK_DEBUG:-}" = "1" ]; then
  node "$bb_honcho_dir/bb-honcho-hook.mjs" "$@"
else
  node "$bb_honcho_dir/bb-honcho-hook.mjs" "$@" 2>/dev/null
fi
exit 0

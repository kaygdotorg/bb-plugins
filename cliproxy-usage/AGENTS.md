# cliproxy-usage: notes for agents

Read this before changing anything. Keep it short; update it in the same commit as the code.

## Map

| Path | What |
|---|---|
| `server.ts` | Settings, the CLIProxyAPI client (credentials, then quota per account), the RPC contract |
| `lib/pool.ts` | Pools accounts per provider for the footer (`usage_summary`) |
| `app.tsx` | The breakdown (a sidebar-footer disclosure) and registrations |
| `footer.tsx` | The percentages inside bb's footer button |

## Rules

- **bb draws footer items itself and only takes an icon, and counts how many fit by measuring them** (`floor((row + gap) / (item + gap)) - 1`). Never change the size of bb's item: a wider button pushed Settings into "…" and made bb re-render the row, dropping the percentages. `footer.tsx` hides the button's icon (same size) and puts the percentages in an overlay in the same `li`, capped at the free space to the next item. A click on the overlay calls the button's native `.click()`, so bb's handler opens the same disclosure. It re-attaches on a 1s check and on row resize.
- **The footer paints the last summary at once** (localStorage `cliproxy-usage:footer-summary`) and refreshes behind it; attach retries at 100/300/700ms, then every second. What remains (~2s) is bb loading plugin bundles.
- **The management key never reaches the app.** Read it server-side only; the app gets projected account fields.
- **Never call CLIProxyAPI's queued usage endpoint:** reading it consumes the records.
- **Other plugins read usage through `bb.sdk.plugins.callRpc`** (`usage_read`, `usage_summary`). Keep both outputs backwards compatible.
- **Footer settings are declarative** (`bb.settings.define`) and reach the app through `useSettings()`.

## Work loop

```sh
npx tsc --noEmit -p . && bb plugin build && bb plugin reload cliproxy-usage
```

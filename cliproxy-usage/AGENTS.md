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

- **bb draws footer items itself and only takes an icon.** `footer.tsx` portals the percentages into bb's own "Provider usage" button and hides its icon, so a click on them is a click on that button and opens the same disclosure. The content has `pointer-events: none`: a click target inside another React tree can miss bb's handler. It re-attaches on a 1s check, because bb re-creates the footer.
- **The management key never reaches the app.** Read it server-side only; the app gets projected account fields.
- **Never call CLIProxyAPI's queued usage endpoint:** reading it consumes the records.
- **Other plugins read usage through `bb.sdk.plugins.callRpc`** (`usage_read`, `usage_summary`). Keep both outputs backwards compatible.
- **Footer settings are declarative** (`bb.settings.define`) and reach the app through `useSettings()`.

## Work loop

```sh
npx tsc --noEmit -p . && bb plugin build && bb plugin reload cliproxy-usage
```

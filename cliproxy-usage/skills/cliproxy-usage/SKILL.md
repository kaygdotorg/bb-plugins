---
name: cliproxy-usage
description: View provider quota windows returned by CLIProxyAPI.
---

# CLIProxyAPI provider usage

The BB sidebar disclosure **Provider usage** shows account quota windows
grouped by provider. It gets the credential list from
`GET /v8/management/credentials`, then fetches normalized quota data from
`POST /v8/management/plugins/<quota-plugin-id>/quota` for accounts that expose
a quota provider. The fetch operation reads upstream quota; it does not reset
or consume it. If no quota provider is registered, the plugin translates the
latest Claude or Codex quota headers stored on that credential into quota
windows. Those fallback values are observed during the most recent routed
request and can be older than the panel refresh time.

Configure the plugin under **Settings → Plugins → CLIProxyAPI Usage** with a
management URL reachable from the BB server and the CLIProxyAPI management
key. The management key remains server-side. The plugin projects the credential
response to account labels and quota fields before sending anything to the app;
tokens and client API keys are never exposed there.

Some CLIProxyAPI credentials may not have a quota provider. Those accounts are
shown with that status. The plugin does not call the queued usage endpoint,
which consumes queued records.

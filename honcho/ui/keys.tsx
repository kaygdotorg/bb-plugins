import { useState } from "react";
import { useAction, useMemoryRpc, useRemote } from "./data";
import { Button, Card, Field, inputClass, Loading, Offline, Section } from "./primitives";

export function KeysTab() {
  const remote = useRemote("keys.get", {}, { live: false, pollMs: 0 });
  const rpc = useMemoryRpc();
  const { busy, error, run } = useAction();
  const [replacement, setReplacement] = useState("");
  const [admin, setAdmin] = useState("");
  const [label, setLabel] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [kind, setKind] = useState("workspace");
  const [target, setTarget] = useState("");
  const [expires, setExpires] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const s = remote.data;
  if (!s) return remote.error ? <Offline message={remote.error} onRetry={() => void remote.refetch()} /> : <Loading what="key details" />;
  const replace = (apiKey: string | null) => void run("replace", async () => {
    try {
      await rpc.call("keys.replace", { apiKey });
      setNotice(apiKey === null ? "Using the config file again." : "Key tested and saved.");
      await remote.refetch();
    } finally { setReplacement(""); }
  });
  return <div className="space-y-5">
    <Section title="Current key" hint="The key value stays private.">
      <Card className="space-y-3 p-3">
        <dl><Field label="Source">{s.source === "bb-secret" ? "BB secret" : s.source === "config-file" ? "Honcho config file" : "No key"}</Field>
          <Field label="Permissions">{s.level === "unknown" ? "Unknown (opaque key)" : s.level}</Field>
          <Field label="Workspace">{s.workspace ?? (s.level === "admin" ? "All workspaces" : s.activeWorkspace)}</Field>
          <Field label="Expires">{s.expiresAt ? new Date(s.expiresAt).toLocaleString() : "No expiry reported"}</Field></dl>
        <p className="text-xs text-muted-foreground">Permissions and expiry describe the key’s claims. The server checks access on every request.</p>
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); replace(replacement); }}>
          <label className="block space-y-1 text-xs">Replace key<input type="password" autoComplete="off" className={inputClass} value={replacement} onChange={e => setReplacement(e.target.value)} /></label>
          <div className="flex flex-wrap gap-2"><Button type="submit" disabled={!!busy || !replacement.trim()}>Test and save</Button>
            <Button disabled={!!busy || s.source !== "bb-secret"} onClick={() => replace(null)}>Use config file again</Button></div>
        </form>
        {notice ? <p role="status" className="text-xs">{notice}</p> : null}
      </Card>
    </Section>
    <Section title="Create a key" hint="Give another machine or assistant only the access it needs.">
      <Card className="space-y-3 p-3">
        {created ? <div className="space-y-2" role="status">
          <p className="text-xs">Save this key now. BB will not show it again.</p>
          <label className="block text-xs">New key<textarea readOnly autoComplete="off" className={`${inputClass} break-all`} value={created} onFocus={e => e.target.select()} /></label>
          <Button onClick={() => setCreated(null)}>I’ve saved it</Button>
        </div> : <form className="space-y-3" onSubmit={e => { e.preventDefault(); void run("mint", async () => {
          try {
            const result = await rpc.call("keys.mint", {
              label: label.trim(), workspace: workspace.trim() || s.activeWorkspace,
              ...(kind === "workspace" ? {} : { [kind]: target.trim() }),
              ...(expires ? { expiresAt: new Date(expires).toISOString() } : {}),
              ...(admin ? { adminKey: admin } : {}),
            });
            setCreated(result.key); await remote.refetch();
          } finally { setAdmin(""); }
        }); }}>
          {s.level !== "admin" ? <label className="block space-y-1 text-xs">Admin key for this request<input aria-label="Admin key for this request" type="password" autoComplete="off" className={inputClass} value={admin} onChange={e => setAdmin(e.target.value)} /><span className="block text-muted-foreground">Your current key cannot create keys unless it has admin access. This value is used once and is never saved.</span></label> : null}
          <label className="block space-y-1 text-xs">Label<input required maxLength={100} className={inputClass} placeholder="For example, hd02" value={label} onChange={e => setLabel(e.target.value)} /></label>
          <label className="block space-y-1 text-xs">Workspace<input className={inputClass} placeholder={s.activeWorkspace} value={workspace} onChange={e => setWorkspace(e.target.value)} /></label>
          <label className="block space-y-1 text-xs">Access<select className={inputClass} value={kind} onChange={e => { setKind(e.target.value); setTarget(""); }}><option value="workspace">Whole workspace</option><option value="peer">One assistant</option><option value="session">One chat</option><option value="scope">One group</option></select></label>
          {kind !== "workspace" ? <label className="block space-y-1 text-xs">{kind === "peer" ? "Assistant ID" : kind === "session" ? "Chat ID" : "Group name"}<input required className={inputClass} value={target} onChange={e => setTarget(e.target.value)} /></label> : null}
          <label className="block space-y-1 text-xs">Expiry (optional)<input type="datetime-local" className={inputClass} value={expires} onChange={e => setExpires(e.target.value)} /></label>
          <Button type="submit" disabled={!!busy || !label.trim() || (kind !== "workspace" && !target.trim()) || (s.level !== "admin" && !admin)}>Create key</Button>
        </form>}
        <p className="text-xs text-muted-foreground">Honcho cannot list or revoke keys. Set an expiry to limit their lifetime. To retire an unexpired key, remove it from its client; server-wide signing-secret rotation invalidates every existing key.</p>
      </Card>
    </Section>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <Section title="Keys created here" hint="Local notes only. Keys created elsewhere do not appear here.">
      {s.notes.length ? <ul className="space-y-2">{s.notes.map(n => <li key={n.id}><Card className="space-y-1 p-3"><p className="text-xs font-medium">{n.label}</p><p className="break-words text-xs text-muted-foreground">{n.workspace}{n.scope ? ` · group ${n.scope}` : n.peer ? ` · assistant ${n.peer}` : n.session ? ` · chat ${n.session}` : " · whole workspace"}</p><p className="text-xs text-muted-foreground">Created {new Date(n.createdAt).toLocaleDateString()} · {n.expiresAt ? `Expires ${new Date(n.expiresAt).toLocaleString()}` : "No expiry"}</p></Card></li>)}</ul> : <p className="text-xs text-muted-foreground">No keys created here yet.</p>}
    </Section>
  </div>;
}

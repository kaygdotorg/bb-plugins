# bb-plugins: notes for agents

Each top-level directory is one bb plugin with its own `README.md` and `AGENTS.md`. Read the plugin's `AGENTS.md` before changing it, and update it in the same commit as the code.

- **Canonical checkout:** `~/Developer/bb-plugins` on hd01 (since 2026-11-15). Plugins are installed from there (`bb plugin install <dir>`), so a build and `bb plugin reload <id>` is live at once.
- **Remotes:** `origin` (Forgejo, kayg/bb-plugins) and `github` (kaygdotorg/bb-plugins, public). Push every commit to both. There are no `~/.ssh/config` entries for these hosts:
  - `GIT_SSH_COMMAND="ssh -i ~/.ssh/git.kayg.org -o IdentitiesOnly=yes" git push origin main`
  - `GIT_SSH_COMMAND="ssh -i ~/.ssh/github.com -o IdentitiesOnly=yes" git push github main`
- **Commits:** atomic, one change each, prefixed with the plugin (`calternal-ui: …`). Git identity `kayg <mail@kayg.org>`.
- **Plugins talk through RPC,** never shared code: calternal-ui and cliproxy-usage are independent, and each degrades gracefully without the other.
- **Never modify bb core.** Everything goes through the plugin SDK, CSS and content scripts.

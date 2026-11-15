# honcho: notes for agents

- **Read [DESIGN.md](DESIGN.md) first.** It is the agreed design (kayg, 2026-11-15). Don't change a decision in it without kayg; when kayg changes one, update DESIGN.md in the same commit.
- **No code before kayg confirms the design.**
- **Never print api keys.** `~/.honcho/config.json` holds them at the top level and under `hosts.*`. Mask every key when you inspect it, not just the top-level one.
- **Measure speed on `kayg@hd02`,** not the perf VMs. Functional tests never assert timings.

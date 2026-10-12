---
"@opengeni/db": patch
---

Make the shared subscription core's organization reach, auto-assignment, plan-change history, workspace inventory and capacity wakes keyed by provider, and move the cutover planner's rules into a provider-neutral module. A later provider's cutover and runtime use the same rows and routines with the provider as data instead of new provider-named copies. Codex behaves exactly as before: its existing reach, auto-assignment rows and plan output are kept, workspaces and Personal workspaces created later are assigned as before, and the Codex-named routines stay in place for binaries that still call them.

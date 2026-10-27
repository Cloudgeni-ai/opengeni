---
"@opengeni/db": patch
---

Grant the runtime `EXECUTE` on `list_agent_held_browser_sessions`, which migration `1002_browser_wait_hold` created withheld (`1004_browser_hold_runtime_grant`). Readiness now requires it, and the API renews controller holds on browsers an agent session keeps while it works or waits.

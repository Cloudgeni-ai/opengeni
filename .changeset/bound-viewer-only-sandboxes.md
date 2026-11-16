---
"@opengeni/db": patch
"@opengeni/config": patch
"@opengeni/react": patch
---

A viewer can no longer keep unlimited sandboxes running with no task. Opening a desktop, terminal or file editor starts a sandbox, and a heartbeating viewer kept it warm indefinitely; under `usage_only` warm billing that compute was free, so scripted accounts could hold hundreds of boxes. A workspace now keeps at most `OPENGENI_SANDBOX_MAX_VIEWER_ONLY_BOXES_PER_WORKSPACE` boxes (default 3, `0` = unbounded) warm with only viewers attached; a viewer that would add one more gets HTTP 429, which the web client already shows as the viewer cap. Joining a box a task or another viewer already holds is unaffected. When the monthly warm allowance (`OPENGENI_SANDBOX_MAX_WARM_SECONDS_PER_WORKSPACE`) is exhausted, viewers on boxes with no running task are now detached on their next heartbeat so those boxes drain, instead of staying warm until the viewer closes; boxes a task holds keep running.

Organizations now also get sandbox limits by subscription plan, counted across every workspace and member (`OPENGENI_SANDBOX_PLAN_LIMITS_JSON`). Defaults: Free 2 viewer-only boxes per organization and 1 per person, Pro 10/3, Max 30/5, Enterprise unbounded; a Free organization whose promotion decision is `held` or `denied` keeps none. Each plan also caps running boxes, including those agent turns hold (Free 3, Pro 20, Max 50): a turn that needs a new box beyond it waits for a slot, retrying every minute without holding a worker, instead of starting one. The organization-wide counts use a new database function (migration 1471) whose runtime grant follows in a later release; until then only the zero limits and the per-workspace viewer limit apply.

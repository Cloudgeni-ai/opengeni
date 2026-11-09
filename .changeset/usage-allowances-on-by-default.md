---
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Workspace budgets and the per-person Personal workspace limit can now be set without extra configuration: `OPENGENI_USAGE_ALLOWANCES_ENABLED` defaults to `true`. It was a rollout gate whose precondition (every API and worker enforcing allowances) always holds now that a release only runs past the 0977 migration baseline, yet it stayed off unless an operator found and set it. `false` still refuses new budgets and limits; existing ones stay enforced and can be removed. Organization settings → Billing → Personal workspaces also shows a plain sentence when a limit can't be saved instead of the raw API error.

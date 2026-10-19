---
"@opengeni/db": patch
---

Avoid capability-row writes for subscription administration checks, allowance state reads, and existing task-budget reads. Coalesce API-key last-use telemetry without caching authorization, and schedule allowance maintenance from actual deadlines and membership changes instead of repeatedly rewriting idle workspaces. Preserve live revocation, usage accounting, and mutation fences.

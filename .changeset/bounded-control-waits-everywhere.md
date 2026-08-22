---
"@opengeni/db": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
"@opengeni/config": patch
"@opengeni/deployment": patch
"@opengeni/testing": patch
---

Bound every HTTP-originated workspace control-prefix wait and make the budget a first-class setting: `updateWorkspaceSettings`, `deleteSessionTreeIfQuiescent`, queue move/edit/delete, composer draft save, and the MCP agent message accept an optional `controlLockTimeoutMs` that API routes and core commands pass (lifecycle callers keep the unbounded wait), so a busy workspace yields the same typed retryable 503 `WORKSPACE_CONTROL_BUSY`. `OPENGENI_WORKSPACE_CONTROL_LOCK_TIMEOUT_MS` is now parsed and validated once at boot by `@opengeni/config` (`workspaceControlLockTimeoutMs`, positive integer ms, default 20000), installed into `@opengeni/db` by `createApp` through `configureWorkspaceControlRequestLockTimeoutMs`, and rendered by the deployment runtime-env generator as an optional passthrough.

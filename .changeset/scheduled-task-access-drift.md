---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
---

Show when a scheduled task's frozen access is out of date, let its owner refresh it, and tell the owner when a run could not use a connector.

For the task owner (or, for a task without an owner, people who manage schedules), scheduled task reads include a read-only `policyDrift`: workspace default connectors the task lacks, connectors the workspace no longer sets up, default OpenGeni tools missing from an agent-created task's frozen creator policy, connectors whose chosen account can no longer be used, and connectors with no account although one is now available. `POST /v1/workspaces/:workspaceId/scheduled-tasks/:taskId/refresh-access` (SDK `refreshScheduledTaskAccess`) re-freezes exactly that with the calling person's current authority through the ordinary owner update path. Only a signed-in person may call it; API keys, services, delegated bearers and agents cannot, a changed task returns 409, and a refreshed creator policy keeps a frozen permission only while that person holds it, adds only the permissions its newly added tools need (within the default worker set and that person's grant), and never changes the creator session policy.

Scheduled runs whose own turn recorded `tool.auth_needed` carry `accessFailures`, and `GET .../scheduled-tasks/attention` (SDK `listScheduledTaskAccessAttention`) lists schedules whose latest run failed that way until a later run succeeds. The web console shows a dot on the Schedules navigation item, a notice on the task card with a one-click refresh, and the failure on each run row.

`@opengeni/contracts` exports `ScheduledTaskPolicyDrift`, `ScheduledTaskAccessConnector`, `ScheduledTaskRunAccessFailure`, `ScheduledTaskAccessAttention`, `ListScheduledTaskAccessAttentionResponse`, and `RefreshScheduledTaskAccessRequest`; `ToolAuthNeededReason` is unchanged but now declared earlier in the module. `@opengeni/db` adds `listScheduledTaskCreatorPolicies`, `listScheduledTaskRunAuthNeededEvents`, `listScheduledTaskAccessAttentionEvents`, and `ScheduledTaskHeadChangedError`, and `updateScheduledTask` accepts `expectedExecutionDigest` and `creatorFirstPartyPolicy`.

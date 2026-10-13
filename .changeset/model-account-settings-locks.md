---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": minor
"@opengeni/subscriptions": minor
---

Organizations can set model-account settings once and lock them for every workspace: rotation, cross-provider failover and its fallback order, whether personal accounts are allowed, and personal fallback. A shared workspace's administrators can override any setting the organization has not locked, and a locked setting cannot be overridden by anyone (enforced in the database; locking clears existing workspace overrides). New routes `GET/PATCH /v1/organizations/:organizationId/model-account-settings`, `GET /v1/organizations/:organizationId/model-account-settings/overview` and `GET/PATCH /v1/workspaces/:workspaceId/model-account-settings` (SDK `getOrganizationModelAccountSettings`, `updateOrganizationModelAccountSettings`, `getModelAccountSettingsOverview`, `getWorkspaceModelAccountSettings`, `updateWorkspaceModelAccountSettings`) report each effective value with its source: the organization, the workspace, or locked by the organization. Migration 0724 is rolling and changes no existing effective setting.

Models settings now edit exact model fallback order, per-provider rotation and their organization locks, support workspace inheritance resets, and paginate the effective-settings overview with per-entry sources. A separate personal preference requires the person's opt-in; organization permission never opts them in, and they can withdraw a prior opt-in even while use is disallowed.

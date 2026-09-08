# Model connection access

Model access is configured on each connected Codex or SuperGrok subscription,
or workspace/organization Gateway or OpenRouter connection. The connection's
nullable model allowlist uses exact public model IDs. `null` permits supported
current and future models; `[]` disables all turn models on that connection.
The existing workspace model policy remains an additional ceiling.

Organization administrators may assign each connection to all shared workspaces
or selected shared workspaces. Codex and SuperGrok also have a separate Personal
workspaces switch. Organization administration does not reveal individual
Personal workspaces or grant access to their contents. Gateway inheritance keeps
its existing shared-workspace boundary. Existing connections default to their
previous reach and unrestricted models.

Migration `0424_model_connection_access.sql` adds policy columns to the existing
credential rows. Restrictive SELECT policies enforce organization workspace
assignment in addition to existing FORCE-RLS tenant and subject policies. The
update guard prevents a workspace caller from changing inherited policies.
Updates require an independent compare-and-set version and record the actor and
time without changing the token or API-key revision. Key replacement and
subscription reconnection retain the connection's policy. Organization subscription
policy writes enter through `updateModelConnectionAccess` in `packages/db/src/index.ts`,
which preserves each provider's pool lock order and commits capacity-waiter wakes
with the policy update. Restoring shared or Personal-workspace access therefore
rechecks queued turns promptly; failed compare-and-set writes and rollbacks emit
no wake. The inventory and wake targets remain internal.

Canonical storage helpers are `packages/db/src/model-connection-access.ts` and
`packages/db/src/workspace-model-connection-access.ts`. The metadata-only
GET/PUT routes are `/v1/{organizations|workspaces}/:scopeId/model-connections/:kind/:connectionId/access`.
Organization administration requires the existing verified browser administrator;
private SuperGrok policy management requires its owning managed browser human.

The workspace catalog intersects connection model permissions with the workspace
policy. Rotation-off catalogs use the effective active subscription; rotating
pools combine permissions from eligible subscriptions. An assigned paused or
unhealthy default remains selected when rotation is off, so disabling rotation
never silently changes the billed account. Codex and SuperGrok allocation filter
accounts by the requested model.
The worker checks the exact selected connection again before model execution,
including pins and recovered leases. Restrictions apply at turn startup; they do
not cancel an already-running model call. Media, transcription, and realtime
capabilities retain their separate policies. A default outside a workspace's
assigned organization pool resolves to the first eligible assigned account,
without changing the organization default. Policy never authorizes a fallback
to a different provider or payment source.

The shared `ConnectionAccessSettings` component renders the same workspace and
model choices under each connected account. The legacy workspace policy remains
under a collapsed Workspace restrictions section and lists ready models only.

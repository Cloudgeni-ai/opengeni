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
accounts by the requested model. The workspace catalog and automatic new-session
defaults also intersect Codex definitions with live `/codex/models` support on
every permitted serving account. A successful catalog omitting a model makes that
choice unavailable; a catalog read failure never proves support. Catalog probes
use the shared refreshing token resolver and cache public model support briefly
per workspace and returned credential revision. The browser, automatic defaults,
and agent model list share these observations.
The worker checks the exact selected connection again before model execution,
including pins and recovered leases. Workspace Gateway and OpenRouter key loading
also checks the exact credential ID. Their catalog and startup checks follow the
same canonical connection order, so permissive legacy duplicates cannot widen
the selected connection’s policy. Restrictions apply at turn startup; they do
not cancel an already-running model call. Media, transcription, and realtime
capabilities retain their separate policies. A default outside a workspace's
assigned organization pool resolves to the first eligible assigned account,
without changing the organization default. Policy never authorizes a fallback
to a different provider or payment source.

In the web app, Settings > Models is one page in the workspace's settings
(there is no separate organization Models page; its old URL redirects). It
shows one row per account this workspace can use, each tagged by who it is for
("Everyone in <organization>", "Selected workspaces", "Shared by
<organization>" when the viewer can't read the policy, "This workspace only",
"Only you"). Organization owners and admins connect organization accounts:
the connect step asks which workspaces can use it, every workspace by default
or "Only selected workspaces" (shared workspaces plus one all-or-nothing
"Personal workspaces" choice, shown off with its reason for organization API
keys), and saves that as the account's "Available in" right after connecting
(`apps/web/src/components/models/connect-audience.tsx`; the connect routes
take no policy, so it is a second request). Owning the account by the
workspace instead is under Advanced. They also see the organization's accounts
that don't reach this workspace, muted with the reason. Each account's own
page carries "Available in" and "Models it can serve"
(`apps/web/src/components/connection-access-settings.tsx`), edited on a form
page. In a workspace the per-account model list shows only once an account is
limited; the workspace-wide "Allowed models" row (the workspace policy) is the
main control and lists ready models only.

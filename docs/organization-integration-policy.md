# Organization integration acquisition policy

Organization owners and administrators configure allowed integrations in
Organization settings → Integrations. An unrestricted organization permits all
supported acquisition flows. A restricted organization permits only its selected
keys; an empty selection denies new acquisitions. The policy applies across the
organization's workspaces, including its personal workspaces.

This is acquisition policy, not connection revocation or execution permission.
Existing connections remain stored and usable subject to their normal authority.
Disconnect, cancellation, removal, and credential refresh retain their existing
behavior. A permitted integration does not grant workspace access, personal
ownership, scopes, or permission to call tools.

The policy covers the integration setup and installation surfaces, not all host
configuration. Deployment-configured tools and embedding-host session-local
`mcpServers` retain their existing admission rules. Session inheritance,
header-only credential rotation, and accepted host-delegation use are unchanged.
Do not present this setting as a universal outbound-network or tool-execution
allowlist.

## Server administration

Use the full-access organization API key on the product backend, or a verified
native organization-administrator session. Workspace keys, delegated users and
agent identities cannot administer this policy. Browser writes also require the
existing same-origin mutation checks.

The SDK subpath `@opengeni/sdk/organization-integration-policy` exports:

- `getOrganizationIntegrationCatalog(client, organizationId)` — discover named
  stable keys instead of guessing provider IDs.
- `getOrganizationIntegrationPolicy(client, organizationId)` — read mode,
  selected keys and current revision.
- `updateOrganizationIntegrationPolicy(client, organizationId, request)` — submit
  `mode`, `allowedIntegrationKeys`, `expectedRevision`, and a fresh `operationId`.

The corresponding routes are GET and PUT
`/v1/organizations/:organizationId/integration-policy`, and GET its `/catalog`
child. No workspace ID is needed for organization administration.

On an uncertain write outcome, retain and retry the exact operation ID and body.
A completed replay returns its historical result; it does not restore an old
policy. A revision conflict requires reading current state and making a new
explicit decision, not silently overwriting another administrator's change.

## Integration identities

Dedicated provider adapters and curated API definitions use server-owned keys.
Aliases for one service, such as Fiken's token and OAuth setup, share a policy
key. The catalog labels distinguish personal Slack accounts from Slack bots and
separate GitHub personal accounts, App installations and PR review.

Custom MCP, OpenAPI and GraphQL have separate broad permissions:
`custom:mcp`, `custom:openapi`, and `custom:graphql`. A manually entered URL,
provider domain or workspace-authored catalog ID never establishes curated
identity. Generic MCP catalog installation uses `custom:mcp`; registry discovery
does not turn every discovered server into a dedicated policy adapter. API
auto-detection probes only protocols the policy permits.

## Persistence and recovery contract

The authoritative storage and SQL write operation are introduced by migration
`0470_organization_integration_policy.sql`. Contracts live in
`packages/contracts/src/organization-integration-policy.ts`; application helpers
live in `packages/db/src/organization-integration-policy.ts`.

An acquisition transaction takes the shared organization-policy lock before
membership, tenancy or credential locks. The policy writer takes the exclusive
policy lock before its administrator checks. Use read-committed isolation and
the transaction passed to the callback for final writes. Never upgrade the
shared acquisition lock into a policy write.

Slow provider preparation occurs outside database transactions. Preflight may
deny it early; final persistence checks current policy again. A restriction
committed during provider work prevents later local acquisition, but cannot
recall an already-issued remote request.

`withOrganizationIntegrationAcquisition` is for new effects. Receipt-aware
operations use `withOrganizationIntegrationPolicyFence`, validate ordinary
actor/origin authority, return an exact completed receipt when present, and
assert allowed classification before new claims or commits. A failed provider
operation is not permission to replay a mutation or invent a new operation ID.

Source selections and facet lifecycle changes distinguish added authority from
unchanged or reducing operations under their existing version/ownership checks.
Schedule materialization following an accepted source selection remains derived
execution; this policy does not replace scheduler authorization.
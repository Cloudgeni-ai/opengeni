# Production checklist

## Keys and configuration

- Use a long-lived organization API key from Organization settings > Developer,
  stored in the product's secret manager. The signup setup key expires after
  30 days.
- Set `OPENGENI_TOOL_SERVER_URL` to the production tool endpoint. The proxy and
  `verifyToolRequest` must see the same URL and the same `OPENGENI_API_KEY`.
- Self-hosted: set `OPENGENI_API_BASE_URL` and pass it as `baseUrl`.
- Pin every `@opengeni/*` package to one version. If the repository enforces a
  minimum release age, pin an older shared version or ask the user; do not
  bypass the policy.
- Private chats need the organization's private-session setting. Without it the
  SDK throws `OpenGeniSetupError`, whose message says who can enable it.
- With cookie auth, pass the product's CSRF check as `authorizeMutation`.

## Tests to keep

- Every proxy and tool route rejects signed-out requests.
- Swapping in another user's or tenant's session id or record id fails.
- The tool endpoint rejects expired, forged, and wrong-audience tokens.
- Write tools ask for approval, or are deliberately auto-approved.
- No key or token appears in responses, logs, browser bundles, or prompts.

## Errors

SDK calls throw `OpenGeniApiError` with `status`, `code`, `retryable`, and
`outcomeUnknown`. Retry only when `retryable` is true. When `outcomeUnknown` is
true, the action may already have happened: read the current state before
trying again. Show users the product's own messages and keep raw errors in
server logs.

## Members and permissions

New members get workspace read, session create/read/control, file
upload/read, and MCP attachment, with no admin rights. Change the default for
new members with `memberPermissions` on `new OpenGeni(...)`. Change an existing
member with
`og.client.updateExternalWorkspaceMember(organizationId, workspaceId, membershipId, { permissions, operationId })`;
remove one with `cancelExternalWorkspaceMemberGrant`, which also stops their
running turns.

## Explicit provisioning

Products that must create workspaces ahead of time, or map identities
themselves, can call the lower-level API on `og.client`: `ensureWorkspace` (an
idempotent tenant-to-workspace mapping), `addExternalWorkspaceMember`, and
`asUser(userId, { source })` to act as a user. Return `{ user, workspaceId }`
from `resolve` to use those workspaces with the proxy.

## Usage and billing

Per-seat allowances, team budgets, and usage meters:
https://docs.opengeni.ai/guides/usage-allowances.

## Handoff

Tell the user what works, what you verified (including the isolation tests),
where the key lives, and what is left for them: the production key, deployment,
and any setting only an administrator can change.

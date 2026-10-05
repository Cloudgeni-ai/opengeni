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
- With cookie auth, pass the product's existing CSRF check as
  `authorizeMutation`. If it has none, keep the default (it refuses cross-site
  mutations by `Sec-Fetch-Site`); a hand-written Origin/Host check breaks
  behind proxies, tunnels, and preview URLs.

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

Opengeni adds a user to the workspace on their first request, with workspace
read, session create/read/control, file upload/read, and MCP attachment, and no
admin rights. The API key needs `members:manage` for this; full-access keys
have it. Change an existing member's permissions with
`og.client.updateExternalWorkspaceMember(organizationId, workspaceId, membershipId, { permissions, operationId })`
(`organizationId` from `await og.resolveOrganizationId()`). To remove a user,
stop resolving them; removing the membership alone does not stop them, because
their next request adds it again. `cancelExternalWorkspaceMemberGrant` also
stops their running turns.

## Explicit provisioning

Products that create workspaces ahead of time, or choose member permissions up
front, can call the lower-level API on `og.client`: `ensureWorkspace` (an
idempotent tenant-to-workspace mapping), `addExternalWorkspaceMember`, and
`asUser(userId, { source })` to act as a user. Return `{ user, workspaceId }`
from `resolve` to use those workspaces with the proxy. Adding a member
explicitly after their first request returns 409 when the permissions differ;
update the member instead.

## Usage and billing

Per-seat allowances, team budgets, and usage meters:
https://docs.opengeni.ai/guides/usage-allowances.

## Handoff

Tell the user what works, what you verified (including the isolation tests),
where the key lives, and what is left for them: the production key, deployment,
and any setting only an administrator can change.

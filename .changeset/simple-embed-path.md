---
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/core": patch
"@opengeni/db": patch
---

Simple embedding path. An organization API key acting as a user (`asUser`) on a
shared workspace of its own organization now adds that user's missing membership
once, with conversation permissions, when the key holds `members:manage` plus
those permissions; existing memberships are never changed. The `@opengeni/sdk/chat`
`OpenGeni` facade derives `organizationId` from the key, maps `{ user, tenant }`,
`{ user }` (one workspace per user), or `{ user, workspaceId }` to a workspace
created on first use, and `og.workspaceId({ tenant } | { user } | { workspaceId })`
translates your ids. The session proxy reports its resolved workspace in client
config, so `<OpenGeniChat baseUrl="/api/opengeni" />` and
`<SessionConversation baseUrl="/api/opengeni" sessionId={id} />` need no provider
or workspace id. Explicit membership APIs and provider-based usage are unchanged.

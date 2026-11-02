---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

**My things** lists every one of a person's own logins, model subscriptions and machines in the organization in one place, grouped by kind, each with where it works. Opening one shows the same **Where it works** switches its own page has. It opens from the account menu and from Settings under Your account. Before, a person had to visit each connector, plan and machine to see which workspaces it worked in.

`GET /v1/workspaces/:workspaceId/own-resources` returns the caller's own logins, then plans, then machines, each with its account or name, provider, reported plan and the same workspace list the reach endpoint returns. Only the caller's own things appear, and only kinds they may list. The SDK adds `listOwnResources`, and `@opengeni/react` adds `MyThings`; `useOwnResourceReach` accepts `initialWorkspaces` so a list can seed each row without reading it again.

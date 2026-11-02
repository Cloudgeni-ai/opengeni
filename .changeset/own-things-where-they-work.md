---
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/api-router": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
---

A person's own logins, model subscriptions and machines each show **Where it works**: every workspace the person belongs to in the organization, with a switch for each. It replaces the single "Use for my messages here" switch, so a person can see and change every workspace from one place instead of visiting each. Logins and subscriptions always work in the Personal workspace; a machine can be turned off there too. The machine page shows the list under "Who can use it?".

`GET /v1/workspaces/:workspaceId/own-resources/reach?resourceKind=&resourceId=` lists the workspaces, Personal first, each with `on`, `alwaysOn` and `canChange`; `PUT` on the same path with `{ resourceKind, resourceId, on }` turns it on or off in that workspace through the existing standing personal-resource grants. `resourceKind` is `connection`, `subscription_connection` or `connected_machine`. Anything that isn't the caller's own answers 404; turning a login or subscription off in the Personal workspace answers 422. The SDK adds `getOwnResourceReach` and `setOwnResourceReach`, and `@opengeni/react` adds `OwnWhereItWorksSection`, `OwnWhereItWorksCard` and `useOwnResourceReach`, plus a `whereItWorks` slot on `MachineDetail`.

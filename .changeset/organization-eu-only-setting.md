---
"@opengeni/contracts": minor
"@opengeni/db": minor
---

Add the organization EU-only inference setting. Any member can read it; owners
and admins (or an administering organization key or agent) can turn it on, and
only an owner or admin in the app in a browser, signed in within the last five
minutes, can turn it off. The database
makes every change through one function that checks these rules and records it.
Changing it becomes available once a later release grants that function.
`isWorkspaceEuOnly` answers whether a workspace's model calls must stay in the
EU and throws when it cannot tell; enforcement follows in later changes.

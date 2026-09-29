---
"@opengeni/contracts": minor
"@opengeni/core": patch
"@opengeni/sdk": minor
---

`createScheduledTask` accepts `firstPartyMcpTools` and `firstPartyMcpPermissions`
with the same meaning and narrowing rules as `createSession`, so an embedder can
give scheduled runs the same minimal OpenGeni tool surface it uses for sessions.
They are frozen for every generated session; omitted keeps the deployment
default. Not allowed for existing-session tasks or agent-created schedules
(which already inherit their session's policy).

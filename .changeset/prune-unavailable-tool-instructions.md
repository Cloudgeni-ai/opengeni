---
"@opengeni/runtime": patch
"@opengeni/contracts": minor
---

Configured agents are no longer told to call first-party tools that their attempt cannot reach. `BuildAgentOptions.agentPromptToolAvailability` (derived with `deriveAgentPromptToolAvailability` from the accepted first-party selection and permission ceiling) removes only instruction clauses that name a tool proven absent; deferred, external and unknown tools keep their guidance, and omitting it keeps today's bytes. `@opengeni/contracts` now exports the first-party tool registration table (`FIRST_PARTY_TOOL_AUTHORIZATION`, `permissionsRequiredByFirstPartyTools`) previously private to the API.

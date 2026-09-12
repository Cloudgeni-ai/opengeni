---
"@opengeni/contracts": patch
"@opengeni/config": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
---

Add explicit accepted-turn host binding selection for shared conversations. Capture each participant's exact owner delegation without changing the configured destination or borrowing creator credentials, preserve fixed bindings and scheduled/child live authority checks, and apply session-local server configuration to follow-up selection. Document the supported empty-session then first-text admission flow.
---
"@opengeni/contracts": minor
"@opengeni/config": minor
"@opengeni/db": patch
"@opengeni/browserd": minor
"@opengeni/runtime": minor
"@opengeni/api-router": minor
---

Add an operator-disabled ephemeral Chromium BrowserSession mode for disposable sandbox verification. Explicit requests use isolated browser contexts within a trusted actor and placement partition, preserve existing private-profile defaults, and become terminal after shared process loss instead of silently recreating or replaying work.

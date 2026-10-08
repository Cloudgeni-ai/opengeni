---
"@opengeni/connect": minor
"@opengeni/contracts": minor
"@opengeni/core": minor
"@opengeni/db": patch
"@opengeni/codemode": minor
"@opengeni/runtime": patch
"@opengeni/sdk": minor
"@opengeni/react": minor
---

Prepare a complete personal or workspace MCP connection once, with non-secret headers and protected secret-field mappings. People enter only the missing key in the conversation card; authorized agents that already have credentials use the same native Connect verification and storage lifecycle without another confirmation card.

Connection, installation and receipt writes are atomic. Exact retries do not repeat verification or create duplicate accounts. The agent path intersects frozen attempt permissions with live ownership, selection, policy and execution fences, and never makes new tools available inside an already accepted attempt. Existing OAuth and explicit account selections remain separate and unchanged.

Deploy matching API and worker packages before using direct agent setup. Historical attempt catalogs without the frozen permission snapshot do not gain new setup authority.

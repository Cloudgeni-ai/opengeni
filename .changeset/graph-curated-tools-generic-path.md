---
"@opengeni/capabilities": minor
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Outlook Mail, Outlook Calendar, Outlook Contacts and OneDrive now offer a reviewed set of tools with hand-written names and descriptions (25, 20, 13 and 19 operations, down from 150, 177, 76 and 452), instead of every Graph operation under their path prefixes. Retained operations keep their tool ids, so installs keep the tools they had; tools that left the set leave existing installs when they move to the new revision. Free/busy schedules no longer need approval (they only read).

A reviewed definition can opt in to `genericPathScope`: a find tool searches the reviewed document's operations under its prefixes, and a read tool (GET) and a change tool (other methods, Ask by default) call one of them by its concrete path, which must match an in-scope operation segment by segment. The four Graph definitions above opt in with their earlier prefixes, so rare operations stay reachable.

Reviewed allowlist entries accept `put` and `delete`, a reviewed `summary` and `operationId`, and a `requestPath` naming other path parameters than the provider's (unnamed ones are dropped, new ones described with `pathParameterDescriptions`).

Every Microsoft Graph definition now reads a commit-pinned Graph OpenAPI document checked against its SHA-256 (`source.pinned`), not msgraph-metadata's moving master branch, so upstream changes no longer create new revisions on their own. `bun scripts/graph-openapi-pin.ts --diff <commit>` shows the operation changes before the pin is moved.

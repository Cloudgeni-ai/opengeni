---
"@opengeni/api-router": patch
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/sdk": patch
"@opengeni/worker-bundle": patch
---

Add `POST /v1/workspaces/:workspaceId/sessions/:sessionId/resources/remove` and SDK `removeSessionResources` to remove repositories from a running session and its child sessions, recorded as `session.resources.removed` events. Access through Opengeni-brokered paths and new credential mints ends on the next call: the personal Git broker, the GitHub tools and Git token minting refuse a removed repository, including for running turns, children and goal continuations. Tokens already in a sandbox stay valid until they expire, except that a dedicated token Opengeni's own GitHub App minted is best-effort revoked. The next managed-sandbox turn removes the repository folder and credential binding.

`Session` gains an optional `removedRepositories` list (migration 1140). A removal lasts until a person attaches the repository again: an agent cannot re-attach it (with a message or a child session, which now returns 403), turns queued earlier leave it out, and child sessions inherit it. Only a person or an API caller can remove repositories. `SessionAuthorizationOperation` gains `"session.resources.write"`; hosts with an exhaustive switch over it must handle the new value.

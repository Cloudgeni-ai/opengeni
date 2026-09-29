---
"@opengeni/api-router": patch
"@opengeni/contracts": minor
"@opengeni/sdk": minor
---

Bad client input no longer answers `500`. A request body that fails its schema
is `400 validation_failed` naming each offending field (malformed JSON too); a
server-side projection failure stays `500`. An unknown `/v1` method or path
answers `405` (with `Allow`) or `404` before authentication, instead of the
retryable `503` the session authorization layer used to return (for example
`GET .../sessions/:id/tool-policy`). `PATCH /v1/workspaces/:id` with `settings`
points at `PATCH /v1/workspaces/:id/settings`, and an Integration install whose
`allowedTools` names a preview `operationKey` (or any unknown value) is a `422`
listing the valid tool ids and the id each operationKey maps to.
`PUT /v1/workspaces/external` (`ensureWorkspace`) accepts an omitted
`accountId` from an organization API key, which creates the workspace in the
key's own organization; every other caller must still send it.

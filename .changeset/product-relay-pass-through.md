---
"@opengeni/sdk": major
"@opengeni/react": minor
---

`createSessionProxyHandler` is now a relay: it forwards every Opengeni route and method inside the resolved workspace as the resolved user, so a product with its own sign-in gives its users the same Opengeni they would get natively (chats and their history, queue, goals, approvals and human input, files, artifacts and Sites, voice, schedules, Knowledge), decided by Opengeni's permissions instead of a list in the relay. Outside the workspace it answers only the bootstrap reads (`GET /v1/workspaces`, `GET /v1/access/me` and `GET /v1/config/client`, each scoped to the resolved workspace); a path naming another workspace is a 403. Path segments are forwarded re-encoded, so keys and subject ids in paths work as in the SDK client. Archived history import (`session-imports`) and browser MCP credential rotation stay refused: only the product's server may write either. Request bodies stream through, Opengeni's statuses, error envelopes and content headers are kept, and SSE streams get heartbeats between events.

Narrow what users can do with the organization key's permissions, the member's permissions (`addExternalWorkspaceMember`, `updateExternalWorkspaceMember`), and the new `refuse(route, context)` hook for routes Opengeni would allow but the product keeps closed (`route` is `{ method, segments, sessionId }`; return `true` for a 404 or a `Response`). Choose what users see with UI props and `SessionApp` presets. `authorizeSession` now also runs for every request that names a chat in `x-opengeni-session-id`.

Breaking:

- Removed options and their replacements: `sessionApp` and `office` (the full app and the Excel add-in work without them), `sessionList` (the list is Opengeni's; pass `listProps={{ mineOnly: true }}` to `OpenGeniChat` or `mineOnly` to `SessionList` for the user's own chats), `archive` (`listProps={{ archive: false }}`), `voiceInput` and `realtimeVoice` (the `voiceInput` and `realtimeVoice` component props), `files`, `sandboxFiles`, `artifacts` and `sites` (permissions, or `refuse` for the routes; `editableLiveUrl` is now a top-level option).
- Newly reachable for a resolved user, within their permissions: every workspace route, including sandbox file reads (`files:read`, without the old workspace-only rewrite), artifact and Site writes (`artifacts:publish`), schedules, Knowledge, chat cancel, workspace pause and resume, and archive with Pause (`sessions:control`). Without a `createSession` hook the browser now creates chats with Opengeni's own create request (MCP credential updates refused), with `chats` defaults filling what it leaves out.
- Artifact and Site reads are no longer checked against the session that produced them; `authorizeSession` and Opengeni's `artifacts:read` decide (a product that wants the old check calls `getSessionProxyArtifactAssociation` from `refuse`). `downloadSessionProxySiteHtml`, `SESSION_PROXY_SITE_HTML_MAX_BYTES` and `SessionProxySiteHtmlTooLargeError` are removed; Site HTML keeps Opengeni's sandboxing and download headers.
- Without `authorizeMutation`, mutations with a `text/plain` or `application/x-www-form-urlencoded` body are now refused as well as cross-site ones.
- The client config no longer reports `sessionCreation`, `archive`, `realtimeVoice` or `sandboxFiles`; `artifacts` is reported whenever the editor's live socket and the user's grant are available. Stock components treat the missing flags as available and keep honoring them from older relays.
- Create and other responses keep Opengeni's status (for example `202` for a created chat).

`@opengeni/react`: `SessionList` gains `mineOnly`, and `OpenGeniChat` forwards it through `listProps`.

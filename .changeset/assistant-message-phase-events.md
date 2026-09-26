---
"@opengeni/runtime": patch
"@opengeni/contracts": patch
"@opengeni/events": patch
"@opengeni/db": patch
"@opengeni/sdk": patch
"@opengeni/react": patch
"@opengeni/api-router": patch
"@opengeni/worker-bundle": patch
---

Emit one `agent.message.completed` per assistant message with its provider `messageId` and `phase`. Runtime normalization read a text field that Agents SDK message items do not have, so no per-message completion or phase ever reached events. Deltas now carry the phase a Responses provider declares, also through compact delta coalescing, and a message the model follows with tool work in the same response is `commentary`. The worker skips the phase-less settlement copy once the stream completed the final text.

Commentary is activity: it no longer marks a session unread (rolling migration 0522 indexes the new attention predicate), wakes `session_wait` change mode, becomes a Slack post, or enters the SDK chat reply. A turn that settles with only commentary still replies with its latest note. The MCP conversation view labels commentary, `latest: "terminal"` skips it, and the React timeline knows a streaming note is commentary from its first delta. `phase` stays optional.

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

Emit one `agent.message.completed` per assistant message with its `phase` and, when the provider sent one, its `messageId`. Runtime normalization read a text field that Agents SDK message items do not have, so no per-message completion or phase ever reached events. Deltas now carry the phase a Responses provider declares, also through compact delta coalescing. An undeclared message gets the SDK's own rule: `commentary` when the same response asks for client tool work (including a client tool search) or ends with a later message, `final_answer` for the message the SDK returns. A Responses message completes as soon as it finishes, before the next message streams, instead of after the whole response. The worker skips the phase-less settlement copy once the stream completed the final text.

Commentary is activity: it no longer marks a session unread (rolling migration 0527 indexes the new attention predicate), wakes `session_wait` change mode, becomes a Slack post, or enters the SDK chat reply. A turn that settles with only commentary still replies with its latest note. When a human or API message's turn ends waiting for input (`wait_for_input`), settlement records its latest assistant message on `turn.completed` as `reply` (the output stays empty; a child an agent spawned and a scheduled, automation or maintenance session's first turn record none), so a status answer given before waiting again marks the session unread and becomes a Slack post with the requester mention while delivery stays open for the result; stored history keeps the provider's phase. The SDK chat fold completes each segment by `messageId`, so a note completed after its answer streamed never repeats the answer. The MCP conversation view labels commentary, `latest: "terminal"` skips it, and the React timeline knows a streaming note is commentary from its first delta. `phase` stays optional.

Older SDK clients see the new completions too: their live reply now separates a note from the answer that follows it in the same response with a blank line (it was run together before), and `history()` lists each completed note as its own assistant message. Roll the API before the workers: an older API process next to a newer worker can briefly post notes to Slack, wake `session_wait` change mode on them, and mark sessions unread for them.

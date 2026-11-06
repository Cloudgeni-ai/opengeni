---
"@opengeni/api-router": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Agents get each waiting rule once, which costs about 450 fewer o200k tokens on every model call of a session that has `wait_for_input`. The `wait_for_input` description now opens with when not to use it (only waiting for the person's answer: reply and end the turn) and is the one place that explains `reply`, the deadline that persists across a question asked during a wait, the timeout minimum, and what starts the next turn; it no longer names goals, child sessions, Steer, Codemode or session tools a session may not have. Its `reply` field no longer invites agents to omit it; the description says when it is needed. The system prompt keeps only when to end a turn on a wait, and its other waiting guidance still follows the features the session has. Idempotency keys that agents make up for `wait_for_input`, goal updates and progress, and session messages, pauses, resumes, Steers and human-input answers now accept any 8-4-4-4-12 hex UUID, as their `format: "uuid"` says, instead of refusing keys without RFC version and variant digits; Opengeni's own tools no longer show the model the regular expression that only repeats that format. Wake behaviour and the reply guard are unchanged.

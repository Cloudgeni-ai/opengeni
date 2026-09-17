---
"@opengeni/contracts": minor
"@opengeni/db": minor
"@opengeni/sdk": minor
"@opengeni/react": minor
"@opengeni/core": patch
---

Add authorized, resumable literal search of saved user and completed assistant
messages, including unloaded history. Workspace search can return one
representative match per session; in-session Find returns every occurrence with
stable event identity and original-text UTF-16 offsets. Requests and browser
result batches remain bounded, with explicit continuation and provisional counts.

Expose bounded exact-sequence history navigation and message highlighting for
React hosts. The web console connects a contextual session-search dialog to
full-history Find, preserves search state across navigation, and keeps ended
conversations readable. Tool output, reasoning and unfinished delta-only
assistant messages are outside the initial searchable scope.
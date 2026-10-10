---
"@opengeni/api-router": patch
---

`session_events` returns a named tool's latest result in one call (`toolName` with `includeOutput`, up to three calls per page), and its refusals for a corrupted cursor, a guessed event type, or selectors on the wrong view now name the corrected call. `callId`/`toolName` sent with a non-tools view read `view: "tools"` and report it in `notice`.

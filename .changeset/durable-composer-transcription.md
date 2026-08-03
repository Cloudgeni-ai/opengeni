---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Persist timesliced composer voice recordings in browser storage with reload-safe document ownership, opener/duplicate-tab fencing, oldest-first recovery, byte-ceiling enforcement, and durable transcript-before-draft handoff. Interrupted audio retries reuse the same recording, uncertain saved transcripts require explicit insertion instead of automatic retranscription or duplicate append, and transient handed-off cleanup failures are retried and garbage-collected owner-safely.
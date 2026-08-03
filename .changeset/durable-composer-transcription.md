---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

Persist timesliced composer voice recordings in browser storage with stale-fenced per-tab ownership, oldest-first recovery, byte-ceiling enforcement, and durable transcript-before-draft handoff. Interrupted audio retries reuse the same recording, while uncertain saved transcripts require explicit insertion instead of automatic retranscription or duplicate append.
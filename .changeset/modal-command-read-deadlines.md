---
"@opengeni/runtime": patch
---

Stage large repository setup scripts in bounded chunks and pass run-as command payloads once in provider arguments to stay within Modal's command size limit. Preserve partial Modal output at quiet-stream deadlines without extending retry admission, accept identity-only first-observation receipts without advancing cursors, and reuse captured complete terminal observations after provider handles expire. Commands are never replayed.

---
"@opengeni/sdk": patch
---

Fix composer draft save and submit through a session proxy with model selection disabled. Saves ignore browser model, reasoning effort, and latency choices and use the authenticated actor's server-side draft policy (initially the session defaults). Submit preserves the mandatory saved-policy snapshot as an API revision/content integrity fence, so identical retries replay the original receipt even after another draft replaces that actor's policy; missing, invalid, or changed submit policy is rejected, not rewritten into a new selection.
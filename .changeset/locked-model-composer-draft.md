---
"@opengeni/sdk": patch
---

Fix composer draft save and submit through a session proxy with model selection disabled. Required model, reasoning effort, and latency fields now come from the authenticated actor's server-side draft instead of accepting browser choices or omitting the API's mandatory policy snapshot.
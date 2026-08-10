---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Retain explicit image-tool outputs before they enter live agent history, preventing inline image bytes from reaching durable session history during SDK event/state ordering skew.

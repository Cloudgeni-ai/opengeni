---
"@opengeni/browserd": patch
"@opengeni/contracts": patch
"@opengeni/observability": patch
"@opengeni/runtime": patch
---

A computer or browser driver failure (`driver_failed`) now tells operators what failed. The controller sends the failing error class and function beside the unchanged error, and server logs record them with the driver message's code-written part, with window titles, page text, paths and free-text reasons redacted. The controller's own log line for a failed request is redacted the same way and now also covers known driver failures. What callers and agents are shown does not change.

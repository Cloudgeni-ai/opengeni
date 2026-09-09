---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Retain Modal command handles, output, and exact exit status across provider-client reconstruction. Persist output pages before acknowledging them, and treat unavailable command journals as unknown rather than proof of process loss.
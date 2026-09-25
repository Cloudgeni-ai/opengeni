---
"@opengeni/db": patch
"@opengeni/core": patch
---

Count the one-time verified-signup trial grant as OpenGeni credits when resolving the default model for new work. Any positive credit balance now selects the configured credits default (after a saved workspace default or a connected subscription), and a balance at or below zero falls back to the deployment default.

---
"@opengeni/api-router": minor
---

Session create over HTTP accepts an organization agent named as `agent: "<key or id>"` or `agent: { ref, ... }`; the route's early body check no longer refuses it as an invalid agent object. The Console test chat route now reads its inner session create correctly when the caller accepts compressed responses. A fork of a chat that runs an organization agent runs the same agent version with the same recorded overrides.


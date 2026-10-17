---
"@opengeni/api-router": patch
---

Agent requests to the API no longer re-read the attempt's frozen learning policy on every call. The policy is a per-turn snapshot that never changes, so the API remembers it per exact attempt after the live-attempt check, which still runs on every request. This removes a row-locking database read from each agent tool call.

---
"@opengeni/runtime": patch
---

Send the system prompt as the leading input item on every Responses route, not only OpenAI's: a `system` message on AI Gateway, SuperGrok and OpenAI-compatible servers, a `developer` message where OpenAI runs the backend.

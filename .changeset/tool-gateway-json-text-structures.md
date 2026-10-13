---
"@opengeni/tool-gateway": patch
---

Accept a nested object or array sent as JSON text where the tool schema needs that object or array. The gateway decodes it only when the whole string is JSON of exactly the expected type, repairs decoded values in a few bounded passes, and still rejects the call unless the result passes the original schema.

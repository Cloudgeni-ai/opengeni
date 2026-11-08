---
"@opengeni/runtime": patch
---

Retry durable stop-request handoff for unresolved Connected Machine commands during turn finalization, independently of stalled cancellation or observation requests. Preserve exact operation identity and retain the writer until custody commits or terminal completion is proven.

---
"@opengeni/runtime": patch
"@opengeni/react": patch
---

Derive Connected Machine list state from the durable heartbeat cursor instead of a live ControlRpc ping on every `GET /machines`, and share one `useMachines` poll per workspace+session.

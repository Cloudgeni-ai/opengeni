---
"@opengeni/runtime": patch
"@opengeni/events": patch
---

Recover Connected Machine control replies across NATS reconnects and credential rotation using negotiated, process-scoped delivery receipts. Retries share one immutable delivery and cannot repeat a mutation. Requires a native agent containing the reply journal; older agents retain conservative one-shot mutation behavior. Tool schemas, result text, and existing history are unchanged.

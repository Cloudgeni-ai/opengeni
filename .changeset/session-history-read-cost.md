---
"@opengeni/db": patch
---

Two frequent session history reads now cost what they need instead of the whole transcript. Checking whether a session has used the tool router is a lookup in a small partial index instead of parsing every history item of sessions that never used it. Clearing finished tool calls reads the turn newest-first and stops once the just-finished calls are proven durable, instead of loading every item of the turn after each tool batch.

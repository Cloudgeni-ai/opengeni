---
"@opengeni/agent-proto": patch
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/core": patch
---

Fence attempt-owned secret-file writes against cleanup, including late accepted writes, reconnects and agent restarts. Record cleanup ownership before dispatch, retain failed erasure for maintenance, and require the agent's durable secret-file fencing capability.

---
"@opengeni/db": patch
---

A person finishing a browser or computer handoff now resumes the agent's `interaction_request_human` call with the settled handoff. The resumed turn read the handoff outside the workspace's row-security scope, so under a database role that enforces it the call failed with "Interaction intervention resumed without a durable response".

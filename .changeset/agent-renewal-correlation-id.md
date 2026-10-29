---
"@opengeni/agent-host": patch
---

When credential renewal fails with a server error, the machine agent's log now includes the deployment's correlation id, so the failure can be matched to the server's log entry. Only a plain id is logged, never the response body.

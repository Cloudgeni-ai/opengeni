---
"@opengeni/worker-bundle": patch
"@opengeni/core": patch
"@opengeni/api-router": patch
---

Preserve durable wake acknowledgment receipts through API and worker signalers. Report pending admission and unconfirmed legacy signal delivery separately from acknowledged revisions, so transport acceptance cannot be mistaken for agent execution progress. Existing wake retries and admission fences remain authoritative.

---
"@opengeni/api-router": patch
"@opengeni/db": patch
---

The compute agent gateway now renews its open sandbox links in batches. Each tick it groups open sessions by workspace and renews up to 250 of them with a single locked statement, instead of one database transaction per sandbox every 5 seconds. Every claim gets the same answer as before (renewed, superseded, lost or revoked); rows are locked in id order so overlapping batches cannot deadlock; and a lease that is already longer is never shortened. At 2,000 open sandboxes a tick drops from 8,000 statements to 32. On staging, with about 2,100 open sandbox links, these renewals had become the largest write load on the database: about 420 transactions per second.

`@opengeni/db` exports `renewSandboxAgentLinks` and `SANDBOX_AGENT_LINK_RENEW_BATCH_MAX`. `ComputeAgentLinkStore` gains `renewMany`. `bun scripts/operator/bench-sandbox-link-renewal.ts [sandboxes]` compares the two forms.

---
"@opengeni/runtime": minor
"@opengeni/config": minor
"@opengeni/db": minor
"@opengeni/worker-bundle": minor
"@opengeni/tool-gateway": patch
"@opengeni/codemode": patch
---

Add opt-in MCP operation outcome recovery through a configured read-only provider receipt tool. Persist exact operation identity before dispatch, retain original invocation outcomes separately from late receipts, and revalidate current authority across accepted attempts without replaying mutations. Preserve arbitrary SDK call IDs as correlation rather than replacing UUID operation identity.

Apply the additive operation-ledger migration and runtime-role provisioning, and upgrade all claim-capable workers to the membership-first lock order before enabling provider mappings. Providers must implement the documented observation contract; unsupported providers and historical operations without captured authority are not automatically recoverable.
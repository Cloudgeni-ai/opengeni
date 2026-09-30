---
"@opengeni/sdk": minor
"@opengeni/contracts": minor
"@opengeni/react": patch
---

Add recoverable allowance lifecycle state and idempotent clear receipts.
Preserve typed allowance scope and reset details in web, MCP, and Slack
refusals with administrator-specific remedies.
Expose browser-safe refusal helpers through `@opengeni/sdk/allowance-refusal`
without widening React's runtime dependency boundary.

Recheck allowance after paid compaction and align continuation admission with
its frozen causal lineage. Keep allowance storage compatible with rolling
deployment, preserve settled usage across period edits, harden definer search
paths, and order organization locks before tenancy fences.
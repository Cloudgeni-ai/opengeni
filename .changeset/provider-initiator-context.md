---
"@opengeni/contracts": minor
"@opengeni/sdk": minor
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Include exact accepted-turn initiator context in signed credential-provider
requests, with human/service/agent attribution and bounded causal lineage for
children, continuations, and coalesced updates. Preserve initiating-human fields
and authorization; expose the additive context through the SDK verifier.
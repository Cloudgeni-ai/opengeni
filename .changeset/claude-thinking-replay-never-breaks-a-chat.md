---
"@opengeni/runtime": patch
"@opengeni/react": patch
---

Replayed Claude thinking no longer breaks a chat. Claude Opus, Sonnet and Haiku 5.5 and Fable 5.2 bind each thinking block to the exact earlier request prefix, and that prefix legitimately changes between turns (for example when a turn adds a repository Skill, which the next turn's system prompt lists). Every thinking request to these models now opts into Anthropic's `drop_block` binding control, so the provider drops only stale blocks instead of refusing the whole request, and the thinking mode stays the same on every request of a conversation. On every Claude transport, a 400 that refuses a replayed thinking signature is sent once more with those blocks as readable historical reasoning, and the refusal is remembered for that provider. If Claude still refuses, the turn fails with the code `anthropic_reasoning_replay_rejected` and a short message instead of Claude's raw error text.

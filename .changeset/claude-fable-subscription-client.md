---
"@opengeni/runtime": patch
---

Claude Fable 5.2 now runs on Claude subscriptions. Anthropic refused it with HTTP 400 because subscription requests presented Claude Code 2.1.285, and Fable 5.2 needs 2.1.290 or newer. Fable 5.2 requests now present Claude Code 2.1.321 (Agent SDK 0.3.321). Every other model keeps 2.1.285, so the billing block at the start of sessions that are already running never changes and their prompt cache stays intact.

---
"@opengeni/runtime": patch
---

On Codex subscription, OpenAI platform and Azure OpenAI Responses requests, the agent's system prompt is now sent as the leading `developer` input item instead of top-level `instructions`. GPT-6.2 and later models place `instructions` after the input and never cache them, so the whole system prompt was billed as uncached input on every request; as a leading developer item it is part of the cached prefix again. Earlier models cache both shapes.

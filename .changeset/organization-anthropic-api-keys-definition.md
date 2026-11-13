---
"@opengeni/config": patch
---

An organization's several Anthropic API keys are no longer part of a model's definition. Before this, the first turn of a new chat on an organization Anthropic API model with several keys failed after five recoveries, and adding a key or a key running out of credits failed the turns already running.

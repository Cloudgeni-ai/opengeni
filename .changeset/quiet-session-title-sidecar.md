---
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Generate automatic session titles on chat-completions providers, including the free default model, through one direct request outside the agent runner instead of a runner-only traced call that always failed. The title request now uses the model's lowest runnable reasoning effort and a larger output budget, and a response stopped by the output limit keeps only whole words.

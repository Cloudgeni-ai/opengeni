---
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Generate automatic session titles on chat-completions providers, including the free default model, through one direct request outside the agent runner instead of a runner-only traced call that always failed. Routes without a resolved provider client now take the same direct path. The title request uses the model's lowest runnable reasoning effort and a larger output budget, a response stopped by the output limit keeps only whole words, and inline `<think>` reasoning before the answer is dropped. Automatic titles no longer keep a dangling closing quote or markdown mark from a wrapped title such as `"Pod Crash Debugging"` or `**Pod Crash Debugging**`.

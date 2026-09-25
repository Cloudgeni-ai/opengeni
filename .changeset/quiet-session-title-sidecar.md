---
"@opengeni/config": patch
"@opengeni/contracts": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

Generate automatic session titles on chat-completions providers, such as OpenRouter connections, through one direct request outside the agent runner instead of a runner-only traced call that always failed. Routes without a resolved provider client now take the same direct path. The title request uses the model's lowest runnable reasoning effort and a larger output budget, a response stopped by the output limit keeps only whole words, and inline `<think>` reasoning before the answer is dropped. Automatic titles no longer keep a dangling closing quote or markdown mark from a wrapped title such as `"Pod Crash Debugging"` or `**Pod Crash Debugging**`. The managed OpenRouter free route (`isManagedOpenRouterFreeRoute`: the deployment-funded OpenRouter provider serving a `:free` variant) sends no title request, because it would spend the deployment key's shared per-minute and per-day request limits that users' turns need; those sessions keep the prompt preview until a turn on another route titles them.

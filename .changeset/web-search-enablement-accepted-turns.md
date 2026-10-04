---
"@opengeni/config": patch
---

Turning on hosted web search for an existing model no longer fails turns accepted under the old definition. An accepted turn whose digest matches the current model with `capabilities.hostedTools.webSearch` set back to `{ upstream: "unknown", runnable: false }` still verifies, and it keeps running without the tool; the next accepted turn gets web search. New export: `configuredModelForAcceptedTurnExecutionPolicy`. Turning web search off and every other definition change still fail closed.

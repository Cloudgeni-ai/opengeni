---
"@opengeni/db": patch
---

Looking up a sandbox by something that is not a sandbox id, such as a machine's display name passed to `sandbox_swap`, now returns "not found" instead of surfacing a raw database cast error to the agent.

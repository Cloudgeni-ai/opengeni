---
"@opengeni/runtime": patch
---

Correct modular tool-discovery guidance: a tool found with `tool_search` stays callable by its exact name, several capabilities can be searched in one response or loaded together through `names`, and goal tools are searched only when their input schema is not in context.

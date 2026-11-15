---
"@opengeni/runtime": patch
---

When an internal filesystem step's outcome cannot be established, the error now says the outcome is unknown, that the step was not repeated, and that there is no background command or handle to read. Before, it said completion was "pending", which led agents to look for a background command that does not exist.

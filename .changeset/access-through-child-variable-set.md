---
"@opengeni/runtime": patch
---

When a step needs a Variable Set the current session does not have, agents run that step in a child session created with it instead of asking the user to attach it.

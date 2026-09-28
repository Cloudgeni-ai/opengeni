---
"@opengeni/runtime": patch
---

When a step needs a workspace Variable Set the current session was not created with, agents run that step in a child created with it instead of asking the user to attach it.

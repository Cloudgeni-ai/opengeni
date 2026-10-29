---
"@opengeni/runtime": patch
---

The agent finishes work when a routine, reversible step is blocked instead of ending the turn with a question: it takes the conventional default without changing user or machine configuration, says which default it took, and continues. It still asks before destructive steps, steps outside the workspace, steps that need authority it has not been given, and choices with no conventional default that would materially change the result.

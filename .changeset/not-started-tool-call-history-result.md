---
"@opengeni/db": patch
---

Tell the model plainly when an `exec_command` call was proven never started
(the sandbox was not ready before dispatch): its recorded result now says
nothing ran and it is safe to run again, instead of the generic interrupted,
outcome-unknown result. Every other interrupted call keeps the existing result.

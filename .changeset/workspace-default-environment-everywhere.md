---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
"@opengeni/sdk": patch
---

New scheduled tasks and new web sessions now pick up the workspace default Sandbox Environment and the default Variable Sets it carries. A scheduled task that omits `rigId` stores the workspace default at creation, the way session create resolves it (an existing-session task keeps its target session's environment, a Connected Machine task stores none, and `null` still opts out); a later change to the workspace default does not move an existing task. Binding an environment to a task's generated sessions, whether by default, by an explicit `rigId` on create or edit, or by switching an existing-session task to generated sessions, now requires permission to attach that environment's default Variable Sets, as session create already did. In a workspace with a default, a Sandbox Environment picked in the composer applies to that session only and is no longer carried into the next new-session form, so later sessions return to the workspace default.

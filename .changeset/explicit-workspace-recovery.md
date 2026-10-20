---
"@opengeni/contracts": patch
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/react": patch
"@opengeni/sdk": patch
---

A chat whose sandbox workspace cannot be restored is no longer stranded: the current archive can be retried on a new attempt, a cold workspace follows the session's selected sandbox backend, and a person can explicitly continue with an empty workspace. The agent then sees a filesystem-discontinuity notice on every later turn, appended at the end of its history.

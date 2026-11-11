---
"@opengeni/browserd": patch
---

A computer session on macOS, Windows or Linux whose CUA worker process stopped (it crashed, was killed, or the machine reclaimed it) now starts a fresh worker on its next call, so the session keeps working. Before, every call to that session failed with an internal error until a new ComputerSession was opened. Reads and pre-action checks are answered by the fresh worker. An action that was not sent fails plainly and retryably, saying nothing was done and to observe the screen again. An action already in progress when the worker stopped stays outcome-unknown and is never repeated. Closing a session whose worker is already gone no longer fails.

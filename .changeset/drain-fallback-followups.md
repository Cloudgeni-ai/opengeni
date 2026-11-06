---
"@opengeni/runtime": patch
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Drain save fallback follow-ups. A save that lands just before (or right after) the drain stops a box whose saves kept failing is now an ordinary saved teardown: the drain waits briefly for it after the stop, and the cold commit re-checks the claim's publication under its lock, so the chat no longer shows "Files changed after {time} couldn't be saved" next to a fresh save. A reduced save whose hard bound expired keeps the lease's only capture slot until its tar has actually returned, so a retry never starts a second tar beside it; past the hour of failures (or in the save window) the next drain stops the box instead. The "restored from an older save" notice is now pending on the lease until it is written and is retried at the next turn start, so a failed write is delivered exactly once instead of being lost. Compute and OpenSandbox workspace tars use the same anchored, glob-escaped exclusions as the workspace fingerprint (`workspaceTarExcludeArgs`), so a nested folder with an ephemeral path's name, or a path containing `*`, `?` or `[`, no longer makes a restore unverifiable.

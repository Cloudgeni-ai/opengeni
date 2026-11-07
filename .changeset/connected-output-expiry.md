---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Background maintenance no longer sweeps connected-command output that can never be captured. A live runner reports the finished operations it still holds, and that report collects their output. Output that is still uncaptured is now recorded as unavailable instead of being retried every few minutes forever:
- a day after its command exited, if its runner was seen alive at least an hour after the exit;
- otherwise, after a week.

For a runner that reports its own operation inventory, such as a compute sandbox, the database recheck now backs off to once every six hours. That runner still collects its output itself whenever it talks. Captured output, recent output and the legacy Connected Machine retry schedule are unchanged.

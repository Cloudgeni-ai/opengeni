---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Background maintenance no longer sweeps connected-command output that can never be captured. A runner keeps a finished command's output for a bounded time (an hour by default). Output still uncaptured a day after its command exited is now recorded as unavailable instead of being retried every few minutes forever. For a runner that reports its own operation inventory, such as a compute sandbox, the database recheck now backs off to once an hour instead of every five minutes. That runner still collects its output itself whenever it talks. Captured output, recent output and legacy Connected Machine retries keep their existing behaviour.

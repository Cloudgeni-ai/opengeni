---
"@opengeni/db": patch
"@opengeni/worker-bundle": patch
---

Connected-command output release sweeps no longer reread output that cannot be released yet. When a command's runner is offline, its output is due again after its age since exit (at least 30 seconds, at most 5 minutes) instead of being checked by every claim, and it is still released once the runner returns. A final output acknowledgement that the runner keeps answering as retained now backs off (30 seconds, doubling to 5 minutes) instead of retrying every reaper period. Foreground command completions no longer take the fenced command lookup or write anything; only runner processes with a matching background command (or one recorded before this release) do.

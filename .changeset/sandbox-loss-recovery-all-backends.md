---
"@opengeni/contracts": patch
"@opengeni/config": patch
"@opengeni/db": patch
"@opengeni/runtime": patch
"@opengeni/worker-bundle": patch
---

A lost sandbox now recovers by itself on every managed backend, not only Modal. Docker, compute and the other hosted providers restore their latest verified checkpoint automatically, with the same "files may be older" warning Modal already gives. A session continues on an empty workspace only with proof that the lost sandbox is really gone: the compute control plane's own answer, a Docker workspace directory that the same daemon shows deleted, or a provider lifetime that has run out. A single transient or false "not found" (for example during host memory pressure) can therefore at most restore a checkpoint and never empties a workspace by itself. A failed rebuild after a loss keeps that loss on record instead of silently starting the session on an empty workspace, so the person who controls the chat can still choose Retry or an empty workspace without any database repair. `SandboxRecoverySelection.artifactId` is now nullable, because a portable checkpoint has no native artifact.

---
"@opengeni/runtime": patch
"@opengeni/observability": patch
"@opengeni/api-router": patch
---

Publishing a sandbox file larger than about 25 MB works on Modal sandboxes again, as does the same private staging on any SDK sandbox without a native private-file write (local, Docker, E2B and others). Such a file is uploaded from the box, and the upload's signed URL is first staged there as a private file. Without a native private-file write, the staging streams the file over the command's input, but that transfer did not opt into the provider's native output collection. Its exit could never be proved, so every large publish failed in under a second as "completion is pending or unknown" before the upload began. The transfer now collects its output like every other internal command, also when it is the first command on a session. This fixes the same staging for workspace file imports. An unexpected Channel-A failure now logs the class of the sandbox error underneath it (for example `SynchronousCommandOutcomeUnknownError`) as `causeName`.

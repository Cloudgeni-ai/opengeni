---
"@opengeni/runtime": patch
"@opengeni/observability": patch
"@opengeni/api-router": patch
---

Publishing a sandbox file larger than about 25 MB works on Modal sandboxes. Such a file is uploaded from the box, and the upload's signed URL is first staged there as a private file. Modal has no native private-file write, so the staging streams the file over the command's input, but that transfer did not opt into the provider's native output collection. Its exit could never be proved, so every large publish failed in under a second as "completion is pending or unknown" before the upload began. The transfer now collects its output like every other internal command, which also fixes the same staging for workspace file imports on Modal. An unexpected Channel-A failure now logs the class of the sandbox error underneath it (for example `SynchronousCommandOutcomeUnknownError`) as `causeName`.

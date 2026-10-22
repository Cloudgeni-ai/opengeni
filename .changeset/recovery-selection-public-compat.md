---
"@opengeni/contracts": patch
"@opengeni/sdk": minor
"@opengeni/db": patch
"@opengeni/react": patch
---

Keep the public sandbox recovery response compatible now that every managed backend recovers a lost sandbox. `SandboxRecoverySelection.artifactId` is a required native checkpoint id again, as it was before, so existing SDK readers never receive null there. A portable checkpoint that an automatic Retry restores is named by the new optional `SandboxRecoveryProjection.automaticCheckpoint` (`SandboxCheckpointSelection`, whose `artifactId` is null for a portable archive); `checkpoint` is set as well only when that checkpoint is native. The packaged recovery actions read `automaticCheckpoint` first. Older clients still recover these sessions when the next message is sent; they only lack the Retry shortcut for a portable checkpoint.

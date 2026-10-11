---
"@opengeni/api-router": patch
---

Fix Google Drive publishing setup failing with `invalid_scope` when the account already has other Google permissions. Keep the folder picker limited to `drive.file`, then use a separate OAuth step to preserve source-read access before enabling publishing.

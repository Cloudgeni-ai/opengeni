---
"@opengeni/api-router": patch
---

Fix Slack workspace picker cards rejected with invalid_blocks by separating repeated action IDs into distinct provider blocks. Preserve existing operation receipts and click handles for safe retries and apply the same serialization to message updates.

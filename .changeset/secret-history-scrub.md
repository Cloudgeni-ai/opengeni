---
"@opengeni/contracts": minor
"@opengeni/api-router": minor
"@opengeni/core": minor
"@opengeni/db": minor
"@opengeni/storage": minor
---

Workspace owners and admins can remove a secret from stored session history with `POST /v1/workspaces/:workspaceId/secret-redactions`. Choose sessions (optionally with their descendants) and match either a vault reference, whose value is read in memory only and never returned, logged or audited (this also needs `secrets:use` on the item), or built-in patterns: URL passwords, optionally for named hosts only, and GitHub tokens. Every stored copy, including archived sessions' long-term storage, is replaced by `[redacted: <reference or kind>]`. `dryRun` counts without changing anything, a second run is a no-op, and the response and audit event carry counts only. New contract exports: `SecretRedactionRequest`, `SecretRedactionResponse`, `SecretRedactionMatch`, `SecretRedactionPattern` and `SecretRedactionCounts`. `@opengeni/storage` now exports `writeCompressedJsonLines`, `readCompressedJsonLines` and the `WorkspaceArchiveSpool` type.

---
"@opengeni/core": patch
"@opengeni/db": patch
"@opengeni/api-router": patch
---

Allow native full organization API keys to administer host MCP resolver registrations. Align request authorization, live-key revalidation, and the database write trigger with the public key contract without granting human organization-admin permissions. Read-only, workspace-scoped, delegated, external-user, expired, and revoked credentials remain denied.